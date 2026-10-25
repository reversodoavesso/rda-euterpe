"""Run INSIDE the web container. Exercises real workers and Spotify writes only
on a new disposable playlist. AI transport uses a local deterministic test double;
no paid provider, API key or model inference is used by this validation.
"""
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.cookiejar
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
import urllib.parse
import uuid

from server import Store, Workers


class Client:
    def __init__(self):
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        self.csrf = ""

    def request(self, path, body=None, method=None, stream=False):
        request = urllib.request.Request("http://127.0.0.1:8080/api" + path, data=json.dumps(body).encode() if body is not None else None, method=method, headers={"Content-Type": "application/json", "X-CSRF-Token": self.csrf})
        try:
            response = self.opener.open(request, timeout=120)
        except urllib.error.HTTPError as error:
            return error.code, json.load(error)
        if stream:
            return response
        with response:
            return response.status, json.load(response)

    def tool(self, name, args=None):
        status, reply = self.request("/tools", {"name": name, "arguments": args or {}})
        if status != 200:
            raise RuntimeError(reply.get("data", {}).get("code", reply.get("error", "tool_failed")))
        return reply["data"]


def main():
    os.umask(0o077)
    store = Store("/data")
    suffix = uuid.uuid4().hex[:10]
    label = "Euterpe Web QA " + suffix
    checks = []
    created = []
    client, other = Client(), Client()
    report = {"mode": "web_runtime", "ai": "local_test_double", "checks": checks, "status": "running"}

    def check(name, condition):
        if not condition:
            raise RuntimeError("verification_failed:" + name)
        checks.append(name)

    def register(c, name):
        status, result = c.request("/account/register", {"username": name, "password": secrets.token_urlsafe(24)})
        check("register_" + ("primary" if c is client else "isolated"), status == 200)
        c.csrf = result["csrf"]
        return store.user(result["user"]["id"])

    a = register(client, "qa" + suffix)
    b = register(other, "qb" + suffix)
    workers = Workers(store)
    root_a, root_b = workers.folder(a), workers.folder(b)
    with store.db() as db:
        local_id = db.execute("SELECT id FROM users WHERE username='local'").fetchone()[0]
    local = store.user(local_id)
    source = store.root / "users" / local_id / "spotify/state.json"
    target = root_a / "spotify/state.json"
    shutil.copyfile(source, target)
    uid_a, uid_b = 20000 + a["number"], 20000 + b["number"]
    os.chmod(target, 0o600)
    os.chown(target, uid_a, uid_a)

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            raw = json.dumps({"data": [{"id": "qa-model"}]}).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = body.get("messages", [])
            last = messages[-1] if messages else {}
            prompt = next((m.get("content", "") for m in reversed(messages) if m.get("role") == "user"), "")
            if last.get("role") == "tool" or not prompt.startswith("probe:"):
                message = {"content": "Resposta de teste concluída.", "role": "assistant"}
            else:
                name = "get_playlists" if prompt == "probe:list" else "create_playlist"
                args = {} if name == "get_playlists" else {"name": label + (" cancel" if prompt == "probe:cancel" else " agent"), "tracks": []}
                message = {"role": "assistant", "tool_calls": [{"id": "call_qa", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
            if body.get("stream"):
                delta = {k: v for k, v in message.items() if k != "role"}
                if "tool_calls" in delta:
                    delta["tool_calls"][0]["index"] = 0
                raw = ("data: " + json.dumps({"choices": [{"index": 0, "delta": delta, "finish_reason": None}]}) + "\n\ndata: " + json.dumps({"choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if "tool_calls" in message else "stop"}]}) + "\n\ndata: [DONE]\n\n").encode()
                kind = "text/event-stream"
            else:
                raw = json.dumps({"choices": [{"message": message}]}).encode(); kind = "application/json"
            self.send_response(200); self.send_header("Content-Type", kind); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    provider = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()

    def proposals(c=client):
        return c.request("/proposals")[1]["proposals"]

    def wait_proposal(name, args=None):
        for _ in range(150):
            for p in proposals():
                if p["name"] == name and (args is None or p["args"] == args):
                    return p
            time.sleep(.1)
        raise RuntimeError("proposal_not_found:" + name)

    def mutation(name, args, approve=True):
        status, job = client.request("/actions", {"name": name, "arguments": args})
        if status != 202:
            raise RuntimeError("action_not_started")
        proposal = wait_proposal("replace_playlist_tracks" if name == "undo_last_mutation" else name, None if name == "undo_last_mutation" else args)
        check("private_proposal_" + str(len(checks)), other.request("/proposals/" + proposal["proposalId"], {"decision": "approve"})[0] == 404)
        client.request("/proposals/" + proposal["proposalId"], {"decision": "approve" if approve else "reject"})
        for _ in range(150):
            _, result = client.request("/jobs/" + job["id"])
            if result["status"] != "pending":
                return result
            time.sleep(.1)
        raise RuntimeError("job_not_completed")

    try:
        check("spotify_session_imported", client.request("/status")[1]["spotify"]["authenticated"])
        check("second_user_starts_without_spotify", not other.request("/status")[1]["spotify"]["authenticated"])
        # Independent Unix identities cannot read the other user's credentials.
        code = subprocess.run(["python3", "-c", "import pathlib,sys;pathlib.Path(sys.argv[1]).read_bytes()", str(target)], user=uid_b, group=uid_b, extra_groups=[], capture_output=True).returncode
        check("os_uid_credentials_isolation", code != 0)
        with store.db() as db:
            code = subprocess.run(["python3", "-c", "import pathlib;pathlib.Path('/data/accounts.sqlite').read_bytes()"], user=uid_a, group=uid_a, extra_groups=[], capture_output=True).returncode
        check("workers_cannot_read_account_database", code != 0)
        code = subprocess.run(["python3", "-c", "import pathlib;pathlib.Path('/data/bootstrap-credentials.json').read_bytes()"], user=uid_a, group=uid_a, extra_groups=[], capture_output=True).returncode
        check("workers_cannot_read_bootstrap_password", code != 0)
        _, pairing = other.request("/spotify/auth/start", {})
        for _ in range(100):
            if pairing.get("user_code") or pairing.get("error"):
                break
            time.sleep(.2)
            _, pairing = other.request("/spotify/auth")
        verify = urllib.parse.urlsplit(pairing.get("verification_url", ""))
        check("web_pairing_issues_code", bool(pairing.get("user_code")) and verify.scheme == "https" and verify.hostname in {"accounts.spotify.com", "spotify.com"})
        check("pairing_stays_in_own_account", client.request("/status")[1]["spotify"]["authenticated"])
        check("web_pairing_can_be_cancelled", other.request("/spotify/auth", method="DELETE")[1]["status"] == "idle")
        library = client.tool("get_playlists")
        baseline = library["total"]
        report["playlists_before"] = baseline
        last_page = client.tool("get_playlists", {"offset": 50, "limit": 50})
        check("library_pagination", len(last_page["playlists"]) == max(0, min(50, baseline - 50)))
        saved = client.tool("get_saved_tracks", {"limit": 2})
        check("liked_tracks", isinstance(saved, list))
        found = client.tool("search_spotify", {"q": "Miles Davis", "limit": 2})
        check("four_search_categories", all(k in found for k in ("tracks", "artists", "albums", "playlists")))
        seed = client.tool("get_playlist_tracks", {"playlist_id": next(p["id"] for p in library["playlists"] if p.get("tracks", 0) > 1)})[:2]
        uris = [t["uri"] for t in seed]
        rejected = mutation("create_playlist", {"name": label + " rejected", "tracks": []}, False)
        check("rejection_does_not_write", rejected["status"] == "failed" and client.tool("get_playlists")["total"] == baseline)
        original_uris = uris + uris[:1]
        made = mutation("create_playlist", {"name": label, "tracks": original_uris})
        check("create_after_approval", made["status"] == "succeeded")
        playlist = made["result"]["playlist_id"]
        created.append(playlist)
        check("create_preserves_reviewed_duplicates", [t["uri"] for t in client.tool("get_playlist_tracks", {"playlist_id": playlist})] == original_uris)
        replaced = mutation("replace_playlist_tracks", {"playlist_id": playlist, "uris": list(reversed(uris)) + [uris[0]]})
        check("replace_order_and_duplicates", replaced["status"] == "succeeded" and [t["uri"] for t in client.tool("get_playlist_tracks", {"playlist_id": playlist})] == list(reversed(uris)) + [uris[0]])
        undone = mutation("undo_last_mutation", {"playlist_id": playlist})
        check("undo_restores_previous_order", undone["status"] == "succeeded" and [t["uri"] for t in client.tool("get_playlist_tracks", {"playlist_id": playlist})] == original_uris)
        patch = mutation("set_playlist_details", {"playlist_id": playlist, "name": label + " verified", "description": "Disposable web validation"})
        check("playlist_details", patch["status"] == "succeeded")

        base = "http://127.0.0.1:" + str(provider.server_address[1])
        check("provider_save", client.request("/providers", {"id": "qa", "name": "Test double", "kind": "openai-compat", "baseUrl": base, "defaultModel": "qa-model", "apiKey": "qa-private-key"})[0] == 200)
        config = {"activeProvider": "qa", "activeModel": "qa-model", "profiles": [{"id": "web-default", "name": "QA", "provider": "qa", "model": "qa-model", "base_url": base}], "activeProfile": "web-default", "roleProfiles": {"chat": "web-default", "curation": "web-default"}, "suggestions": False}
        check("model_settings", client.request("/settings", config, "PUT")[0] == 200)
        listing = client.request("/providers")[1]
        check("provider_keys_not_returned", "qa-private-key" not in json.dumps(listing))
        check("provider_keys_are_per_user", not any(p["id"] == "qa" for p in other.request("/providers")[1]["providers"]))
        check("model_listing", client.request("/models?provider=qa")[1]["models"][0]["id"] == "qa-model")
        check("provider_test", client.request("/providers/test", {"provider": "qa", "model": "qa-model"})[1]["ok"])
        _, conv = client.request("/conversations", {})
        with client.request("/chat", {"conversation_id": conv["id"], "text": "probe:list"}, stream=True) as response:
            sse = response.read().decode()
        check("chat_sse_read_tool_and_done", "event: tool" in sse and "event: stream" in sse and "event: done" in sse)
        history = client.request("/conversations/" + conv["id"])[1]
        check("persisted_chat_history", len(history["messages"]) == 2)
        check("conversation_tenant_isolation", other.request("/conversations/" + conv["id"])[0] == 404)
        # A fresh chat asks to create; explicit stop must remove its pending proposal.
        _, cancel_conv = client.request("/conversations", {})
        with ThreadPoolExecutor(max_workers=1) as pool:
            stream = pool.submit(lambda: client.request("/chat", {"conversation_id": cancel_conv["id"], "text": "probe:cancel"}, stream=True).read())
            p = wait_proposal("create_playlist", {"name": label + " cancel", "tracks": []})
            check("cancel_is_tenant_scoped", other.request("/chat/cancel", {"conversation_id": cancel_conv["id"]})[0] == 404)
            check("chat_cancel_endpoint", client.request("/chat/cancel", {"conversation_id": cancel_conv["id"]})[0] == 200)
            stream.result(timeout=10)
        for _ in range(30):
            if not any(x["proposalId"] == p["proposalId"] for x in proposals()):
                break
            time.sleep(.1)
        check("stop_cleans_pending_proposal_without_write", not proposals() and client.tool("get_playlists")["total"] == baseline + 1)
        # Agent mutation: same human approval route and separate result event.
        _, agent_conv = client.request("/conversations", {})
        with ThreadPoolExecutor(max_workers=1) as pool:
            stream = pool.submit(lambda: client.request("/chat", {"conversation_id": agent_conv["id"], "text": "probe:create"}, stream=True).read())
            p = wait_proposal("create_playlist", {"name": label + " agent", "tracks": []})
            client.request("/proposals/" + p["proposalId"], {"decision": "approve"})
            agent_sse = stream.result(timeout=30).decode()
        created.extend(p["id"] for p in client.tool("get_playlists")["playlists"] if p.get("name") == label + " agent")
        check("agent_mutation_and_stream_complete", "event: proposal" in agent_sse and "event: done" in agent_sse)
        # Activity collection happens just after forwarding done.
        for _ in range(30):
            events = client.request("/activity")[1]["activity"]
            if any(e["kind"] == "agent_mutation" and e["status"] == "succeeded" for e in events):
                break
            time.sleep(.1)
        check("agent_write_result_in_activity", any(e["kind"] == "agent_mutation" and e["status"] == "succeeded" for e in events))
        check("activity_tenant_isolation", other.request("/activity")[1]["activity"] == [])
        report["status"] = "passed"
    except Exception as error:
        report.update(status="failed", error=str(error)[:180])
    finally:
        # Cleanup only exact IDs created in this invocation, never existing playlists.
        try:
            created.extend(p["id"] for p in client.tool("get_playlists")["playlists"] if p.get("name") in {label, label + " verified", label + " agent"} and p["id"] not in created)
        except Exception:
            report["status"] = "failed"
        cleanup = []
        for playlist in created:
            try:
                cleanup.append(mutation("delete_playlist", {"playlist_ids": [playlist]})["status"] == "succeeded")
            except Exception:
                cleanup.append(False)
        report["cleanup"] = all(cleanup)
        try:
            other.request("/spotify/auth", method="DELETE")
        except Exception:
            pass
        try:
            report["playlists_after"] = client.tool("get_playlists")["total"]
            if report["playlists_after"] == report["playlists_before"]:
                checks.append("original_library_count_restored")
            else:
                report["status"] = "failed"
        except Exception:
            report["status"] = "failed"
        if not report["cleanup"]:
            report["status"] = "failed"
        # Retain test account secrets only in the private volume, for diagnosis.
        (store.root / "last-web-validation.json").write_text(json.dumps({"users": [a["id"], b["id"]], "created_playlists": created, "cleanup": report["cleanup"]}))
        provider.shutdown(); provider.server_close(); workers.close()
    print(json.dumps(report, ensure_ascii=False, indent=2))
    raise SystemExit(0 if report["status"] == "passed" else 1)


if __name__ == "__main__":
    main()
