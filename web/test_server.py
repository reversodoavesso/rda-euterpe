"""Gateway contract tests: authentication, tenant boundaries and approval flow."""
from contextlib import contextmanager
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid

from server import make_server, Store, APIError, COOKIE


class FakeWorker:
    def __init__(self):
        self.pending = []
        self.event = threading.Event()
        self.decision = None
        self.writes = 0
        self.settings = {"mutationPolicy": "confirm"}

    def tool(self, name, args):
        if name == "get_playlists":
            return True, {"total": 1, "playlists": [{"id": "own-playlist"}]}
        self.event.clear()
        self.decision = None
        self.pending = [{"proposalId": str(uuid.uuid4()), "name": name, "args": args, "title": name}]
        self.event.wait(4)
        self.pending = []
        if self.decision == "approve":
            self.writes += 1
            return True, {"playlist_id": "own-created"}
        return False, {"code": "user_rejected"}

    def json(self, path, method="GET", body=None):
        if path == "/proposals":
            return 200, {"proposals": self.pending}
        if path.startswith("/proposals/"):
            self.decision = body["decision"]
            self.event.set()
            return 200, {"ok": True}
        if path == "/settings":
            if body:
                self.settings.update(body)
            return 200, {"settings": self.settings, "runtime": {"dataDir": "/private"}}
        if path == "/providers":
            return 200, {"providers": [{"id": "test", "hasKey": True}]}
        if path.startswith("/history/"):
            return 200, {"ok": True}
        return 200, {}


class FakeWorkers:
    def __init__(self):
        self.items = {}

    @contextmanager
    def lease(self, user):
        yield self.items.setdefault(user["id"], FakeWorker())

    def close(self):
        for w in self.items.values():
            w.event.set()


class GatewayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.workers = FakeWorkers()
        cls.server = make_server(cls.directory.name, ("127.0.0.1", 0), cls.workers)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.workers.close()
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    def request(self, path, method="GET", body=None, auth=None, headers=None):
        client = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        req_headers = {"Content-Type": "application/json"}
        if auth:
            req_headers.update(Cookie=auth[0], **{"X-CSRF-Token": auth[1]})
        req_headers.update(headers or {})
        client.request(method, path, json.dumps(body) if body is not None else None, req_headers)
        response = client.getresponse()
        raw = response.read()
        result = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw
        data = (response.status, result, dict(response.getheaders()))
        client.close()
        return data

    def account(self):
        name = "test" + uuid.uuid4().hex[:12]
        status, data, headers = self.request("/api/account/register", "POST", {"username": name, "password": "long-test-password"})
        self.assertEqual(status, 200)
        return (headers["Set-Cookie"].split(";")[0], data["csrf"]), data["user"]

    def test_cookie_csrf_origin_and_logout(self):
        auth, _ = self.account()
        status, data, headers = self.request("/api/me", auth=auth)
        self.assertEqual(status, 200)
        self.assertNotIn("daemon_key", json.dumps(data))
        self.assertEqual(self.request("/api/conversations", "POST", {}, auth, {"X-CSRF-Token": "wrong"})[0], 403)
        self.assertEqual(self.request("/api/conversations", "POST", {}, auth, {"Origin": "https://other.example"})[0], 403)
        self.assertEqual(self.request("/api/account/logout", "POST", {}, auth)[0], 200)
        self.assertEqual(self.request("/api/me", auth=auth)[0], 401)
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])

    def test_login_and_password_limits(self):
        self.assertEqual(self.request("/api/account/register", "POST", {"username": "valid", "password": "short"})[0], 400)
        self.assertEqual(self.request("/api/account/login", "POST", {"username": "missing", "password": "long-test-password"})[0], 401)

    def test_unused_logout_body_cannot_corrupt_the_next_http_request(self):
        auth, _ = self.account()
        client = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        client.request('POST', '/api/account/logout', '{}', {'Content-Type':'application/json','Cookie':auth[0],'X-CSRF-Token':auth[1]})
        response = client.getresponse()
        self.assertEqual(response.status, 200)
        response.read()
        client.request('GET', '/api/me', headers={'Cookie':auth[0]})
        response = client.getresponse()
        self.assertEqual(response.status, 401)
        self.assertEqual(json.loads(response.read())['error'], 'login_required')
        client.close()

    def test_conversations_are_owned_and_erased(self):
        a, _ = self.account()
        b, _ = self.account()
        _, conversation, _ = self.request("/api/conversations", "POST", {"title": "Private"}, a)
        path = "/api/conversations/" + conversation["id"]
        self.assertEqual(self.request(path, auth=b)[0], 404)
        self.assertEqual(self.request(path, "PATCH", {"title": "stolen"}, b)[0], 404)
        self.assertEqual(self.request(path, "DELETE", auth=b)[0], 404)
        self.assertEqual(self.request("/api/conversations", auth=b)[1]["conversations"], [])
        self.assertEqual(self.request(path, "PATCH", {"title": "Renamed"}, a)[0], 200)
        self.assertEqual(self.request(path, auth=a)[1]["title"], "Renamed")
        self.assertEqual(self.request(path, "DELETE", auth=a)[0], 200)
        self.assertEqual(self.request(path, auth=a)[0], 404)

    def test_mutations_require_exact_owner_approval(self):
        auth, user = self.account()
        other, _ = self.account()
        _, job, _ = self.request("/api/actions", "POST", {"name": "create_playlist", "arguments": {"name": "Test"}}, auth)
        worker = None
        for _ in range(100):
            worker = self.workers.items.get(user["id"])
            if worker and worker.pending:
                break
            time.sleep(0.01)
        self.assertEqual(worker.writes, 0)
        self.assertEqual(self.request("/api/actions", "POST", {"name": "create_playlist"}, auth)[0], 409)
        proposal = worker.pending[0]
        path = "/api/proposals/" + proposal["proposalId"]
        self.assertEqual(self.request(path, "POST", {"decision": "approve"}, other)[0], 404)
        self.assertEqual(self.request("/api/jobs/" + job["id"], auth=other)[0], 404)
        self.assertEqual(worker.writes, 0)
        self.assertEqual(self.request(path, "POST", {"decision": "approve"}, auth)[0], 200)
        for _ in range(100):
            result = self.request("/api/jobs/" + job["id"], auth=auth)[1]
            if result["status"] != "pending":
                break
            time.sleep(.01)
        self.assertEqual(result["status"], "succeeded")
        self.assertEqual(worker.writes, 1)
        self.assertEqual(self.request("/api/activity", auth=other)[1]["activity"], [])
        self.assertTrue(self.request("/api/activity", auth=auth)[1]["activity"])

    def test_rejection_performs_no_writes(self):
        auth, user = self.account()
        _, job, _ = self.request("/api/actions", "POST", {"name": "delete_playlist", "arguments": {"playlist_id": "test"}}, auth)
        for _ in range(100):
            worker = self.workers.items.get(user["id"])
            if worker and worker.pending:
                break
            time.sleep(.01)
        self.request("/api/proposals/" + worker.pending[0]["proposalId"], "POST", {"decision": "reject"}, auth)
        for _ in range(100):
            result = self.request("/api/jobs/" + job["id"], auth=auth)[1]
            if result["status"] != "pending":
                break
            time.sleep(.01)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(worker.writes, 0)

    def test_read_endpoint_cannot_mutate_and_policy_cannot_be_bypassed(self):
        auth, _ = self.account()
        self.assertEqual(self.request("/api/tools", "POST", {"name": "create_playlist"}, auth)[0], 400)
        status, result, _ = self.request("/api/settings", "PUT", {"mutationPolicy": "allow", "mutationAllowlist": ["*"], "chatUpstream": "http://evil", "instructions": "music"}, auth)
        self.assertEqual(status, 200)
        self.assertEqual(result["settings"]["mutationPolicy"], "confirm")
        self.assertEqual(result["settings"]["chatUpstream"], "")
        self.assertEqual(result["settings"]["mutationAllowlist"], [])
        self.assertNotIn("runtime", result)

    def test_single_use_ticket_and_hashed_storage(self):
        auth, user = self.account()
        store = self.server.app.store
        ticket = store.ticket(user["id"])
        status, _, headers = self.request("/access/" + ticket)
        self.assertEqual(status, 303)
        self.assertIn("HttpOnly", headers["Set-Cookie"])
        self.assertIn("SameSite=Strict", headers["Set-Cookie"])
        self.assertEqual(self.request("/access/" + ticket)[0], 401)
        with store.db() as c:
            raw = json.dumps([tuple(r) for r in c.execute("SELECT * FROM sessions")])
        self.assertNotIn(auth[0].split("=", 1)[1], raw)

    def test_reopening_store_does_not_interrupt_live_jobs(self):
        _, user = self.account()
        job_id = str(uuid.uuid4())
        with self.server.app.store.db() as c:
            c.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?)", (job_id, user["id"], "test", "{}", "pending", None, time.time()))
        reopened = Store(self.directory.name)
        with reopened.db() as c:
            self.assertEqual(c.execute("SELECT status FROM jobs WHERE id=?", (job_id,)).fetchone()[0], "pending")


if __name__ == "__main__":
    unittest.main()
