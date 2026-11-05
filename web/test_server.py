"""Gateway contract tests: authentication, tenant boundaries and approval flow."""
from contextlib import contextmanager
import http.client
import io
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid
import os
from unittest.mock import patch

from server import make_server, Store, APIError, COOKIE, digest, Worker


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
    def test_public_https_redirect_uses_configured_origin_and_preserves_path(self):
        with patch.dict(os.environ, {'WEB_REQUIRE_HTTPS': 'true', 'WEB_PUBLIC_ORIGIN': 'https://euterpe.example'}):
            status, _, headers = self.request('/path?x=1', headers={'X-Forwarded-Proto': 'http', 'Host': 'untrusted.example'})
            self.assertEqual(status, 308)
            self.assertEqual(headers['Location'], 'https://euterpe.example/path?x=1')
            self.assertEqual(headers['Strict-Transport-Security'], 'max-age=31536000')
            self.assertEqual(self.request('/health', headers={'X-Forwarded-Proto': 'https'})[0], 200)

    def test_public_sso_only_mode_rejects_local_password_login(self):
        with patch.dict(os.environ, {'WEB_LOCAL_LOGIN_ENABLED': 'false'}):
            self.assertFalse(self.request('/api/account/sso/config')[1]['localLoginEnabled'])
            self.assertEqual(self.request('/api/account/login', 'POST', {'username': 'unused', 'password': 'unused'})[:2], (403, {'error': 'use_rda_sso_login'}))

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

    def setUp(self):
        # Each test gets a fresh rate-limit window; production limits remain intact.
        self.server.app.login_attempts.clear()

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

    def test_mcp_token_lifecycle_scope_and_tenant_isolation(self):
        auth, user = self.account()
        other, _ = self.account()
        self.assertEqual(self.request('/api/mcp/tokens', 'POST', {'name': 'client'}, (auth[0], 'wrong'))[0], 403)
        status, issued, _ = self.request('/api/mcp/tokens', 'POST', {'name': 'client', 'expiresInDays': 1}, auth)
        self.assertEqual(status, 201)
        raw = issued['token']
        headers = {'Authorization': 'Bearer ' + raw, 'Accept': 'application/json, text/event-stream'}
        listed = self.request('/api/mcp/tokens', auth=auth)[1]
        self.assertNotIn(raw, json.dumps(listed))
        self.assertNotIn('hash', json.dumps(listed))
        self.assertEqual(self.request('/api/mcp/tokens', auth=other)[1]['tokens'], [])
        self.assertEqual(self.request('/api/mcp/tokens/' + issued['id'], 'DELETE', {}, other)[0], 404)
        with self.server.app.store.db() as c:
            saved = c.execute('SELECT hash FROM mcp_tokens WHERE id=?', (issued['id'],)).fetchone()[0]
        self.assertNotEqual(raw, saved)
        worker = self.workers.items.setdefault(user['id'], FakeWorker())
        def rpc(path, method, body):
            self.assertEqual((path, method), ('/mcp', 'POST'))
            return 200, {'jsonrpc': '2.0', 'id': body['id'], 'result': {'tools': [
                {'name': 'spotify_get_playlists'}, {'name': 'spotify_create_playlist'}, {'name': 'spotify_selection_apply'}]}}
        body = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/list'}
        with patch.object(worker, 'json', side_effect=AssertionError('initialize must not create private sessions')):
            status, initialized, _ = self.request('/mcp', 'POST', {**body, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}}, headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual(initialized['result']['protocolVersion'], '2025-06-18')
            self.assertEqual(self.request('/mcp', 'POST', {**body, 'method': 'ping'}, headers=headers)[1]['result'], {})
        with patch.object(worker, 'json', side_effect=rpc) as mocked:
            status, data, _ = self.request('/mcp', 'POST', body, headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual([t['name'] for t in data['result']['tools']], ['spotify_get_playlists'])
            forbidden = {**body, 'method': 'tools/call', 'params': {'name': 'spotify_create_playlist'}}
            self.assertEqual(self.request('/mcp', 'POST', forbidden, headers=headers)[1]['error']['code'], -32602)
            self.assertEqual(mocked.call_count, 1)
        self.assertEqual(self.request('/mcp', 'POST', body, auth=auth)[0], 401)
        self.assertEqual(self.request('/mcp', 'POST', body, headers={**headers, 'Origin': 'https://attacker.example'})[0], 403)
        self.assertEqual(self.request('/mcp', 'GET', headers=headers)[0], 405)
        self.assertEqual(self.request('/mcp', 'POST', body, headers={**headers, 'MCP-Protocol-Version': 'invalid'})[0], 400)
        self.assertEqual(self.request('/mcp', 'POST', body, headers={**headers, 'Accept': 'text/plain'})[0], 406)
        self.assertEqual(self.request('/mcp', 'POST', {'jsonrpc': '2.0', 'method': 'notifications/initialized'}, headers=headers)[:2], (202, b''))
        self.assertEqual(self.request('/api/mcp/tokens/' + issued['id'], 'DELETE', {}, auth)[0], 200)
        status, _, response_headers = self.request('/mcp', 'POST', body, headers=headers)
        self.assertEqual(status, 401)
        self.assertIn('Bearer', response_headers['WWW-Authenticate'])

    def test_mcp_write_scope_expiry_and_management_boundary(self):
        auth, user = self.account()
        _, issued, _ = self.request('/api/mcp/tokens', 'POST', {'name': 'writer', 'scope': 'write'}, auth)
        headers = {'Authorization': 'Bearer ' + issued['token'], 'Accept': 'application/json, text/event-stream'}
        self.assertEqual(self.request('/api/mcp/tokens', headers=headers)[0], 401)
        worker = self.workers.items.setdefault(user['id'], FakeWorker())
        body = {'jsonrpc': '2.0', 'id': 'write', 'method': 'tools/call', 'params': {'name': 'spotify_create_playlist', 'arguments': {'name': 'Review me'}}}
        with patch.object(worker, 'json', return_value=(200, {'jsonrpc': '2.0', 'id': 'write', 'result': {'isError': True}})) as mocked:
            self.assertEqual(self.request('/mcp', 'POST', body, headers=headers)[0], 200)
            self.assertEqual(mocked.call_args.args, ('/mcp', 'POST', {**body, 'params': {**body['params'], '_requireConfirmation': True}}))
            denied = {**body, 'params': {'name': 'spotify_selection_apply', 'arguments': {}}}
            self.assertEqual(self.request('/mcp', 'POST', denied, headers=headers)[1]['error']['code'], -32602)
        with self.server.app.store.db() as c:
            c.execute('UPDATE mcp_tokens SET expires=0 WHERE id=?', (issued['id'],))
        self.assertEqual(self.request('/mcp', 'POST', body, headers=headers)[0], 401)
        for options in ({'expiresInDays': 91}, {'expiresInDays': True}, {'scope': 'admin'}, {'name': ''}):
            self.assertEqual(self.request('/api/mcp/tokens', 'POST', {'name': 'test', **options}, auth)[0], 400)
        store = self.server.app.store
        local = store.issue_mcp_token(user['id'], {'name': 'before linking'})
        proof = store.issue_session(user['id'])
        store.bind_sso({'issuer': 'https://identity.example', 'sub': str(uuid.uuid4()), 'id': str(uuid.uuid4())}, user['id'], digest(proof))
        with self.assertRaises(APIError):
            store.authenticate_mcp('Bearer ' + local['token'])

    def test_worker_preserves_non_json_rejections_without_exposing_raw_body(self):
        worker = Worker({}, Path('.'), 1, 2)
        for status, raw in ((400, b''), (403, b'private backend diagnostic')):
            response = io.BytesIO(raw)
            response.status = status
            with patch.object(worker, 'request', return_value=response):
                self.assertEqual(worker.json('/workbench/test', 'POST', {}), (status, {'error': 'agent_request_rejected'}))
        response = io.BytesIO(b'broken success')
        response.status = 200
        with patch.object(worker, 'request', return_value=response), self.assertRaises(APIError) as caught:
            worker.json('/mcp', 'POST', {})
        self.assertEqual(caught.exception.status, 502)

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

    def test_chat_audit_is_owned_sanitized_and_erased(self):
        auth, user = self.account()
        other, _ = self.account()
        _, conversation, _ = self.request("/api/conversations", "POST", {}, auth)
        cid = conversation["id"]
        self.server.app.store.audit_event(cid, "run-1", "request.started", {})
        self.server.app.store.message(cid, "user", "Mensagem original")
        self.assertEqual(self.request("/api/conversations/" + cid + "/audit", auth=other)[0], 404)
        logs = [
            {"ts": "2026-10-30T12:00:00Z", "event": "session.start", "payload": {"model": "test-model", "text": "private prompt", "apiKey": "secret"}},
            {"ts": "2026-10-30T12:00:01Z", "event": "tool.result", "payload": {"name": "search_spotify", "ok": False, "code": "rate_limited", "duration_ms": 120, "preview": "secret"}},
            {"ts": "2026-10-30T12:00:02Z", "event": "llm.reasoning", "payload": {"preview": "secret"}},
        ]
        worker = self.workers.items.setdefault(user["id"], FakeWorker())
        original = worker.json
        with patch.object(worker, "json", side_effect=lambda path, *a: (200, logs) if path.startswith("/sessions/") else original(path, *a)):
            status, data, _ = self.request("/api/conversations/" + cid + "/audit", auth=auth)
        self.assertEqual(status, 200)
        self.assertTrue(data["agent_logs_available"])
        self.assertEqual(len(data["events"]), 3)
        self.assertNotIn("secret", json.dumps(data))
        self.assertNotIn("private prompt", json.dumps(data))
        self.assertEqual(data["conversation"]["messages"][0]["content"], "Mensagem original")
        with patch.object(worker, "json", side_effect=OSError("offline")):
            self.assertFalse(self.request("/api/conversations/" + cid + "/audit", auth=auth)[1]["agent_logs_available"])
        self.assertEqual(self.request("/api/conversations/" + cid, "DELETE", auth=auth)[0], 200)
        with self.server.app.store.db() as c:
            self.assertEqual(c.execute("SELECT count(*) FROM chat_audit WHERE conversation_id=?", (cid,)).fetchone()[0], 0)

    def test_chat_audit_records_success_interruption_and_failure(self):
        import io
        auth, user = self.account()
        worker = self.workers.items.setdefault(user["id"], FakeWorker())
        for ending, expected in [(b'event: done\ndata: {}\n\n', "completed"), (b'', "interrupted")]:
            _, conversation, _ = self.request("/api/conversations", "POST", {}, auth)
            stream = io.BytesIO(b'event: tool\ndata: {"name":"search_spotify","args":{"token":"secret"}}\n\nevent: stream\ndata: {"delta":"Resposta"}\n\n' + ending)
            stream.status = 200
            with patch.object(worker, "request", return_value=stream, create=True):
                self.assertEqual(self.request("/api/chat", "POST", {"conversation_id": conversation["id"], "text": "Teste"}, auth)[0], 200)
            for _ in range(50):
                data = self.request("/api/conversations/" + conversation["id"] + "/audit", auth=auth)[1]
                if any(e["event"] == "request.finished" for e in data["events"]):
                    break
                time.sleep(.01)
            final = data["events"][-1]
            self.assertEqual(final["payload"]["outcome"], expected)
            self.assertGreaterEqual(final["payload"]["duration_ms"], 0)
            self.assertNotIn("secret", json.dumps(data))
            self.assertEqual(bool(data["conversation"]["messages"][-1]["interrupted"]), expected == "interrupted")
        _, conversation, _ = self.request("/api/conversations", "POST", {}, auth)
        with patch.object(worker, "request", side_effect=OSError("secret provider error"), create=True):
            self.assertEqual(self.request("/api/chat", "POST", {"conversation_id": conversation["id"], "text": "Teste"}, auth)[0], 502)
        data = self.request("/api/conversations/" + conversation["id"] + "/audit", auth=auth)[1]
        self.assertEqual(data["events"][-1]["payload"]["outcome"], "failed")
        self.assertNotIn("secret", json.dumps(data))

    def test_chat_audit_marks_empty_done_as_failed(self):
        import io
        auth, user = self.account()
        worker = self.workers.items.setdefault(user["id"], FakeWorker())
        _, conversation, _ = self.request("/api/conversations", "POST", {}, auth)
        stream = io.BytesIO(b'event: done\ndata: {}\n\n')
        stream.status = 200
        with patch.object(worker, "request", return_value=stream, create=True):
            self.request("/api/chat", "POST", {"conversation_id": conversation["id"], "text": "Teste"}, auth)
        for _ in range(50):
            data = self.request("/api/conversations/" + conversation["id"] + "/audit", auth=auth)[1]
            if any(e["event"] == "request.finished" for e in data["events"]):
                break
            time.sleep(.01)
        self.assertEqual(data["events"][-1]["payload"]["outcome"], "failed")
        self.assertTrue(any(e["event"] == "error" and e["payload"]["code"] == "empty_response" for e in data["events"]))
        self.assertEqual(data["conversation"]["messages"][-1]["error_code"], "empty_response")
        self.assertTrue(data["conversation"]["messages"][-1]["content"])

    def test_quota_error_is_forwarded_and_persisted_in_conversation(self):
        import io
        auth, user = self.account()
        worker = self.workers.items.setdefault(user["id"], FakeWorker())
        _, conversation, _ = self.request("/api/conversations", "POST", {}, auth)
        stream = io.BytesIO(b'event: error\ndata: {"code":"quota_exhausted"}\n\nevent: stream\ndata: {"delta":"Cota atingida"}\n\nevent: done\ndata: {}\n\n')
        stream.status = 200
        with patch.object(worker, "request", return_value=stream, create=True):
            _, raw, _ = self.request("/api/chat", "POST", {"conversation_id": conversation["id"], "text": "Teste"}, auth)
        self.assertIn(b'event: error', raw)
        message = self.request("/api/conversations/" + conversation["id"], auth=auth)[1]["messages"][-1]
        self.assertEqual(message["error_code"], "quota_exhausted")
        self.assertEqual(message["content"], "Cota atingida")

    def test_workspace_proxy_checks_owner_and_csrf_before_accessing_worker(self):
        auth, user = self.account()
        other, _ = self.account()
        _, conversation, _ = self.request("/api/conversations", "POST", {}, auth)
        path = "/api/conversations/" + conversation["id"] + "/workbench"
        worker = self.workers.items.setdefault(user["id"], FakeWorker())
        calls = []
        def proxy(route, method="GET", body=None):
            calls.append((route, method, body))
            return 200, {"state": {"references": []}, "operations": []}
        with patch.object(worker, "json", side_effect=proxy):
            self.assertEqual(self.request(path, auth=other)[0], 404)
            self.assertEqual(self.request(path, "POST", {"name": "selection_apply"}, auth, {"X-CSRF-Token": "wrong"})[0], 403)
            self.assertEqual(calls, [])
            self.assertEqual(self.request(path, auth=auth)[0], 200)
            self.assertEqual(self.request(path, "POST", {"name": "operation_cancel", "arguments": {"operation_id": "test"}}, auth)[0], 200)
        self.assertEqual(calls[0][:2], ("/workbench/" + conversation["id"], "GET"))
        self.assertEqual(calls[1][2]["name"], "operation_cancel")

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
