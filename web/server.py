"""Euterpe Web: authenticated UI gateway and isolated per-user worker processes.

Only the gateway listens outside the container. Each user gets distinct OS UIDs,
private data directories, daemon credentials, Spotify credentials and agent history.
No Docker socket and no third-party Python packages are required.
"""
from __future__ import annotations

import atexit
import base64
from contextlib import contextmanager
from dataclasses import dataclass, field
import hashlib
import hmac
import html
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import sqlite3
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from rda_sso import RdaSso, SsoError
from mcp_oauth import McpOAuth
from curation import (
    EDITORIAL_MODELS,
    DRAMATURGIAS,
    COORDENADAS_DIEGETICAS,
    EIXOS_CURATORIAIS,
    validate_dag,
    compute_approval_hash,
)
from rda_ai_client import RdaAiClient

STATIC = Path(__file__).parent / "dist"
READ_TOOLS = {"get_playlists", "get_playlist_tracks", "get_saved_tracks", "get_several_tracks", "search_spotify", "resolve_tracks"}
WRITE_TOOLS = {"create_playlist", "delete_playlist", "add_tracks", "remove_tracks", "set_playlist_details", "replace_playlist_tracks", "undo_last_mutation"}
SETTING_KEYS = {"activeProvider", "activeModel", "curationModel", "profiles", "activeProfile", "roleProfiles", "instructions", "suggestions", "chatHistoryTurns", "maxToolSteps", "mutationPolicy"}
COOKIE = "euterpe_session"
SESSION_SECONDS = 7 * 24 * 3600
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class APIError(Exception):
    def __init__(self, code, status=400):
        self.code, self.status = code, status


def identifier(raw):
    try:
        return str(uuid.UUID(raw))
    except (ValueError, TypeError, AttributeError):
        raise APIError("invalid_id") from None


def digest(raw):
    return hashlib.sha256(raw.encode()).hexdigest()


def password_hash(password, salt):
    return hashlib.scrypt(password.encode(), salt=salt, n=32768, r=8, p=1, maxmem=67108864)


class Store:
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        # Workers must traverse the root, but database/configuration stay 0600.
        os.chmod(self.root, 0o711)
        self.path = self.root / "accounts.sqlite"
        with self.db() as c:
            c.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
                    display_name TEXT NOT NULL, salt BLOB NOT NULL, password BLOB NOT NULL,
                    daemon_key TEXT NOT NULL, spotify_key TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS tickets(hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS mcp_tokens(id TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id), name TEXT NOT NULL, scope TEXT NOT NULL,
                    created REAL NOT NULL, expires REAL NOT NULL, last_used REAL);
                CREATE INDEX IF NOT EXISTS mcp_tokens_owner ON mcp_tokens(user_id);
                CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), title TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, role TEXT NOT NULL, content TEXT NOT NULL, interrupted INTEGER NOT NULL DEFAULT 0, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS chat_audit(id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
                    run_id TEXT NOT NULL, event TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS chat_audit_conversation ON chat_audit(conversation_id,id);
                CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), tool TEXT NOT NULL, args TEXT NOT NULL, status TEXT NOT NULL, result TEXT, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS activity(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS sso_bindings(issuer TEXT NOT NULL, subject TEXT NOT NULL,
                    platform_user_id TEXT NOT NULL, user_id TEXT NOT NULL UNIQUE REFERENCES users(id), created REAL NOT NULL,
                    PRIMARY KEY(issuer,subject));
                CREATE TABLE IF NOT EXISTS sso_sessions(hash TEXT PRIMARY KEY REFERENCES sessions(hash) ON DELETE CASCADE,
                    subject TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS curations(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    title TEXT NOT NULL, description TEXT, editorial_model TEXT NOT NULL, dramaturgia TEXT,
                    briefing TEXT, candidates TEXT, selected_tracks TEXT, sequencing TEXT,
                    status TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS curation_workflows(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    curation_id TEXT NOT NULL REFERENCES curations(id) ON DELETE CASCADE, version INTEGER NOT NULL,
                    graph_json TEXT NOT NULL, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS curation_runs(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    curation_id TEXT NOT NULL REFERENCES curations(id) ON DELETE CASCADE, workflow_id TEXT NOT NULL,
                    status TEXT NOT NULL, current_step TEXT, result TEXT, created REAL NOT NULL, updated REAL NOT NULL);
                CREATE INDEX IF NOT EXISTS conversations_owner ON conversations(user_id,updated);
                CREATE INDEX IF NOT EXISTS activity_owner ON activity(user_id,created);
                CREATE INDEX IF NOT EXISTS curations_owner ON curations(user_id,updated);
            """)
            c.execute("INSERT OR IGNORE INTO meta VALUES ('csrf_key',?)", (secrets.token_hex(32),))
            self.csrf_key = bytes.fromhex(c.execute("SELECT value FROM meta WHERE key='csrf_key'").fetchone()[0])
            if "error_code" not in {row[1] for row in c.execute("PRAGMA table_info(messages)")}:
                c.execute("ALTER TABLE messages ADD COLUMN error_code TEXT")
        os.chmod(self.path, 0o600)

    @contextmanager
    def db(self):
        c = sqlite3.connect(self.path, timeout=15)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA foreign_keys=ON")
        try:
            with c:
                yield c
        finally:
            c.close()

    def issue_mcp_token(self, user_id, body):
        name = body.get('name', '')
        days = body.get('expiresInDays', 30)
        scope = body.get('scope', 'read')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 80:
            raise APIError('invalid_token_name')
        if type(days) is not int or not 1 <= days <= 90 or scope not in ('read', 'write'):
            raise APIError('invalid_token_options')
        raw = 'eut_mcp_' + secrets.token_urlsafe(32)
        token_id, now = str(uuid.uuid4()), time.time()
        expires = now + days * 86400
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            count = c.execute('SELECT count(*) FROM mcp_tokens WHERE user_id=? AND expires>?', (user_id, now)).fetchone()[0]
            if count >= 20:
                raise APIError('token_limit', 409)
            c.execute('INSERT INTO mcp_tokens VALUES (?,?,?,?,?,?,?,NULL)',
                      (token_id, digest(raw), user_id, name.strip(), scope, now, expires))
        return {'id': token_id, 'token': raw, 'name': name.strip(), 'scope': scope, 'expires': expires}

    def mcp_tokens(self, user_id):
        with self.db() as c:
            return [dict(row) for row in c.execute(
                'SELECT id,name,scope,created,expires,last_used FROM mcp_tokens WHERE user_id=? ORDER BY created DESC', (user_id,))]

    def revoke_mcp_token(self, user_id, token_id):
        with self.db() as c:
            if not c.execute('DELETE FROM mcp_tokens WHERE id=? AND user_id=?', (token_id, user_id)).rowcount:
                raise APIError('token_not_found', 404)

    def authenticate_mcp(self, authorization):
        scheme, _, raw = (authorization or '').partition(' ')
        if scheme.lower() != 'bearer' or not raw.startswith('eut_mcp_') or len(raw) > 128:
            raise APIError('invalid_token', 401)
        with self.db() as c:
            row = c.execute('SELECT id,user_id,scope FROM mcp_tokens WHERE hash=? AND expires>?', (digest(raw), time.time())).fetchone()
            if row is None:
                raise APIError('invalid_token', 401)
            c.execute('UPDATE mcp_tokens SET last_used=? WHERE id=?', (time.time(), row['id']))
        return self.user(row['user_id']), row['scope']

    def user(self, user_id):
        with self.db() as c:
            row = c.execute("SELECT rowid AS number,* FROM users WHERE id=?", (user_id,)).fetchone()
        if row is None:
            raise APIError("account_not_found", 404)
        return dict(row)

    def register(self, body):
        username = str(body.get("username", "")).strip().lower()
        display = str(body.get("display_name", username)).strip()[:80]
        password = body.get("password", "")
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{2,47}", username):
            raise APIError("invalid_username")
        if not isinstance(password, str) or not 12 <= len(password) <= 128:
            raise APIError("password_minimum_12")
        salt = secrets.token_bytes(16)
        encoded = password_hash(password, salt)
        user_id = str(uuid.uuid4())
        try:
            with self.db() as c:
                c.execute("INSERT INTO users VALUES (?,?,?,?,?,?,?,?)", (user_id, username, display or username, salt, encoded, secrets.token_urlsafe(36), secrets.token_urlsafe(36), time.time()))
        except sqlite3.IntegrityError:
            raise APIError("username_unavailable", 409) from None
        return self.user(user_id)

    def login(self, body):
        username = str(body.get("username", "")).strip().lower()
        password = body.get("password", "")
        if not isinstance(password, str) or len(password) > 128:
            raise APIError("invalid_credentials", 401)
        with self.db() as c:
            row = c.execute("SELECT id,salt,password FROM users WHERE username=?", (username,)).fetchone()
            if row and c.execute('SELECT 1 FROM sso_bindings WHERE user_id=?', (row['id'],)).fetchone():
                raise APIError('rda_sso_required', 401)
        salt = bytes(row["salt"]) if row else b"euterpe-invalid-user"
        candidate = password_hash(password, salt)
        if row is None or not hmac.compare_digest(candidate, bytes(row["password"])):
            raise APIError("invalid_credentials", 401)
        return self.user(row["id"])

    def bind_sso(self, profile, local_user_id=None, local_session_hash=None):
        with self.db() as c:
            c.execute('BEGIN IMMEDIATE')
            if local_user_id:
                proof = c.execute('SELECT user_id FROM sessions WHERE hash=? AND expires>?', (local_session_hash, time.time())).fetchone()
                if not proof or proof['user_id'] != local_user_id:
                    raise APIError('local_account_proof_expired', 401)
            found = c.execute('SELECT user_id,platform_user_id FROM sso_bindings WHERE issuer=? AND subject=?', (profile['issuer'], profile['sub'])).fetchone()
            if found:
                if found['platform_user_id'] != profile['id'] or local_user_id and found['user_id'] != local_user_id:
                    raise APIError('sso_identity_already_linked', 409)
                return self.user(found['user_id'])
            if local_user_id:
                if c.execute('SELECT 1 FROM sso_bindings WHERE user_id=?', (local_user_id,)).fetchone():
                    raise APIError('local_account_already_linked', 409)
                user_id = local_user_id
            else:
                user_id = str(uuid.uuid4())
                username = 'rda-' + uuid.uuid4().hex
                c.execute('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)', (user_id, username, str(profile.get('displayName') or 'Conta RDA')[:80],
                    secrets.token_bytes(16), secrets.token_bytes(64), secrets.token_urlsafe(36), secrets.token_urlsafe(36), time.time()))
            c.execute('INSERT INTO sso_bindings VALUES (?,?,?,?,?)', (profile['issuer'], profile['sub'], profile['id'], user_id, time.time()))
            c.execute('DELETE FROM sessions WHERE user_id=?', (user_id,))
            c.execute('DELETE FROM mcp_tokens WHERE user_id=?', (user_id,))
        return self.user(user_id)

    def sso_binding(self, user_id):
        with self.db() as c:
            row = c.execute('SELECT issuer,subject,platform_user_id FROM sso_bindings WHERE user_id=?', (user_id,)).fetchone()
        return dict(row) if row else None

    def issue_session(self, user_id):
        token = secrets.token_urlsafe(36)
        with self.db() as c:
            c.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
            c.execute("INSERT INTO sessions VALUES (?,?,?)", (digest(token), user_id, time.time() + SESSION_SECONDS))
        return token

    def authenticate(self, cookie):
        parsed = SimpleCookie()
        try:
            parsed.load(cookie or "")
            token = parsed[COOKIE].value
        except (KeyError, ValueError):
            raise APIError("login_required", 401) from None
        with self.db() as c:
            row = c.execute("SELECT user_id FROM sessions WHERE hash=? AND expires>?", (digest(token), time.time())).fetchone()
        if not row:
            raise APIError("login_required", 401)
        return self.user(row["user_id"]), token

    def csrf(self, token):
        return hmac.new(self.csrf_key, token.encode(), hashlib.sha256).hexdigest()

    def ticket(self, user_id):
        if self.sso_binding(user_id):
            raise APIError('rda_sso_required', 401)
        token = secrets.token_urlsafe(36)
        with self.db() as c:
            c.execute("INSERT INTO tickets VALUES (?,?,?)", (digest(token), user_id, time.time() + 600))
        return token

    def consume_ticket(self, token):
        with self.db() as c:
            c.execute("BEGIN IMMEDIATE")
            row = c.execute("SELECT user_id FROM tickets WHERE hash=? AND expires>?", (digest(token), time.time())).fetchone()
            c.execute("DELETE FROM tickets WHERE hash=?", (digest(token),))
        if not row:
            raise APIError("access_link_expired", 401)
        if self.sso_binding(row['user_id']):
            raise APIError('rda_sso_required', 401)
        return self.issue_session(row["user_id"])

    def conversation(self, user_id, conversation_id):
        conversation_id = identifier(conversation_id)
        with self.db() as c:
            row = c.execute("SELECT * FROM conversations WHERE id=? AND user_id=?", (conversation_id, user_id)).fetchone()
            if not row:
                raise APIError("conversation_not_found", 404)
            messages = [dict(m) for m in c.execute("SELECT role,content,interrupted,created,error_code FROM messages WHERE conversation_id=? ORDER BY id", (conversation_id,))]
        return {**dict(row), "messages": messages}

    def audit_event(self, conversation_id, run_id, event, payload):
        with self.db() as c:
            c.execute("INSERT INTO chat_audit(conversation_id,run_id,event,payload,created) VALUES (?,?,?,?,?)",
                      (conversation_id, run_id, event, json.dumps(payload, ensure_ascii=False), time.time()))

    def message(self, conversation_id, role, content, interrupted=False, error_code=None):
        with self.db() as c:
            c.execute("INSERT INTO messages(conversation_id,role,content,interrupted,created,error_code) VALUES (?,?,?,?,?,?)", (conversation_id, role, content, int(interrupted), time.time(), error_code))
            c.execute("UPDATE conversations SET updated=? WHERE id=?", (time.time(), conversation_id))

    def activity(self, user_id, kind, title, status, data=None):
        with self.db() as c:
            c.execute("INSERT INTO activity(user_id,kind,title,status,data,created) VALUES (?,?,?,?,?,?)", (user_id, kind, title, status, json.dumps(data or {}, ensure_ascii=False), time.time()))

    def curations(self, user_id):
        with self.db() as c:
            rows = [dict(r) for r in c.execute("SELECT * FROM curations WHERE user_id=? ORDER BY updated DESC", (user_id,))]
        for r in rows:
            r["briefing"] = json.loads(r["briefing"]) if r.get("briefing") else {}
            r["candidates"] = json.loads(r["candidates"]) if r.get("candidates") else []
            r["selected_tracks"] = json.loads(r["selected_tracks"]) if r.get("selected_tracks") else []
            r["sequencing"] = json.loads(r["sequencing"]) if r.get("sequencing") else []
        return rows

    def curation(self, user_id, curation_id):
        curation_id = identifier(curation_id)
        with self.db() as c:
            row = c.execute("SELECT * FROM curations WHERE id=? AND user_id=?", (curation_id, user_id)).fetchone()
            if not row:
                raise APIError("curation_not_found", 404)
            wf_row = c.execute("SELECT id,version,graph_json FROM curation_workflows WHERE curation_id=? ORDER BY version DESC LIMIT 1", (curation_id,)).fetchone()
        item = dict(row)
        item["briefing"] = json.loads(item["briefing"]) if item.get("briefing") else {}
        item["candidates"] = json.loads(item["candidates"]) if item.get("candidates") else []
        item["selected_tracks"] = json.loads(item["selected_tracks"]) if item.get("selected_tracks") else []
        item["sequencing"] = json.loads(item["sequencing"]) if item.get("sequencing") else []
        item["workflow"] = json.loads(wf_row["graph_json"]) if wf_row else None
        return item

    def create_curation(self, user_id, body):
        title = str(body.get("title", "Novo Projeto de Curadoria")).strip()[:120] or "Novo Projeto de Curadoria"
        desc = str(body.get("description", "")).strip()[:500]
        model_id = str(body.get("editorial_model", "escuta-e-imagem-v2"))
        dramaturgia_id = str(body.get("dramaturgia", "montanha_russa"))
        briefing = body.get("briefing", {})
        now = time.time()
        curation_id = str(uuid.uuid4())

        model = next((m for m in EDITORIAL_MODELS if m["id"] == model_id), EDITORIAL_MODELS[0])
        steps = [
            {
                "id": s["id"],
                "kind": s["kind"],
                "label": s["label"],
                "role_function": s["role_function"],
                "model_alias": s.get("model_alias", "rda/chat-default"),
                "instructions": s.get("instructions", ""),
                "allowed_tools": s.get("tools", []),
                "requires_approval": s.get("requires_approval", False),
                "position": s.get("pos", {"x": 100, "y": 150}),
            }
            for s in model.get("default_steps", [])
        ]
        edges = model.get("default_edges", [])
        graph = {
            "workflow_id": f"wf_{curation_id[:8]}",
            "version": 1,
            "domain_id": "euterpe",
            "owner_user_id": user_id,
            "visibility": "private",
            "default_model_alias": "rda/chat-default",
            "execution_profile": model.get("recommended_profile", "equilibrado"),
            "steps": steps,
            "edges": edges,
        }
        wf_id = str(uuid.uuid4())
        with self.db() as c:
            c.execute(
                "INSERT INTO curations VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (curation_id, user_id, title, desc, model_id, dramaturgia_id, json.dumps(briefing, ensure_ascii=False), "[]", "[]", "[]", "draft", now, now)
            )
            c.execute(
                "INSERT INTO curation_workflows VALUES (?,?,?,?,?,?,?)",
                (wf_id, user_id, curation_id, 1, json.dumps(graph, ensure_ascii=False), now, now)
            )
        return self.curation(user_id, curation_id)

    def update_curation(self, user_id, curation_id, body):
        curation_id = identifier(curation_id)
        with self.db() as c:
            row = c.execute("SELECT id FROM curations WHERE id=? AND user_id=?", (curation_id, user_id)).fetchone()
            if not row:
                raise APIError("curation_not_found", 404)
            updates, params = [], []
            if "title" in body:
                updates.append("title=?")
                params.append(str(body["title"]).strip()[:120])
            if "description" in body:
                updates.append("description=?")
                params.append(str(body["description"]).strip()[:500])
            if "dramaturgia" in body:
                updates.append("dramaturgia=?")
                params.append(str(body["dramaturgia"]))
            if "briefing" in body:
                updates.append("briefing=?")
                params.append(json.dumps(body["briefing"], ensure_ascii=False))
            if "candidates" in body:
                updates.append("candidates=?")
                params.append(json.dumps(body["candidates"], ensure_ascii=False))
            if "selected_tracks" in body:
                updates.append("selected_tracks=?")
                params.append(json.dumps(body["selected_tracks"], ensure_ascii=False))
            if "sequencing" in body:
                updates.append("sequencing=?")
                params.append(json.dumps(body["sequencing"], ensure_ascii=False))
            if "status" in body:
                updates.append("status=?")
                params.append(str(body["status"]))
            updates.append("updated=?")
            params.append(time.time())
            params.extend([curation_id, user_id])
            c.execute(f"UPDATE curations SET {', '.join(updates)} WHERE id=? AND user_id=?", params)
        return self.curation(user_id, curation_id)

    def delete_curation(self, user_id, curation_id):
        curation_id = identifier(curation_id)
        with self.db() as c:
            c.execute("DELETE FROM curations WHERE id=? AND user_id=?", (curation_id, user_id))
        return {"ok": True}

    def save_curation_workflow(self, user_id, curation_id, graph_dict):
        curation_id = identifier(curation_id)
        steps = graph_dict.get("steps", [])
        edges = graph_dict.get("edges", [])
        is_valid, order, error_msg = validate_dag(steps, edges)
        if not is_valid:
            raise APIError(error_msg or "invalid_workflow_dag", 422)

        with self.db() as c:
            row = c.execute("SELECT id FROM curations WHERE id=? AND user_id=?", (curation_id, user_id)).fetchone()
            if not row:
                raise APIError("curation_not_found", 404)
            last_wf = c.execute("SELECT version FROM curation_workflows WHERE curation_id=? ORDER BY version DESC LIMIT 1", (curation_id,)).fetchone()
            version = (last_wf["version"] + 1) if last_wf else 1
            graph_dict["version"] = version
            graph_dict["domain_id"] = "euterpe"
            graph_dict["owner_user_id"] = user_id
            now = time.time()
            wf_id = str(uuid.uuid4())
            c.execute("INSERT INTO curation_workflows VALUES (?,?,?,?,?,?,?)", (wf_id, user_id, curation_id, version, json.dumps(graph_dict, ensure_ascii=False), now, now))
            c.execute("UPDATE curations SET updated=? WHERE id=?", (now, curation_id))
        return {"ok": True, "workflow_id": wf_id, "version": version, "topological_order": order}


@dataclass
class Worker:
    user: dict
    root: Path
    port: int
    spotify_port: int
    processes: list = field(default_factory=list)
    used: float = field(default_factory=time.monotonic)
    requests: int = 0

    @property
    def base(self):
        return f"http://127.0.0.1:{self.port}"

    def request(self, path, method="GET", body=None, timeout=150):
        raw = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=raw, method=method, headers={"Authorization": "Bearer " + self.user["daemon_key"], "Content-Type": "application/json"})
        try:
            return OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            return error

    def json(self, path, method="GET", body=None):
        try:
            with self.request(path, method, body) as response:
                try:
                    value = json.load(response)
                except ValueError:
                    # Axum can reject a request with an empty/text 4xx body.
                    # Preserve that rejection without exposing the raw response.
                    if 400 <= response.status < 500:
                        return response.status, {"error": "agent_request_rejected"}
                    raise
                return response.status, value
        except (OSError, ValueError, TimeoutError):
            raise APIError("agent_unavailable", 502) from None

    def tool(self, name, args):
        status, reply = self.json("/mcp", "POST", {"jsonrpc": "2.0", "id": str(uuid.uuid4()), "method": "tools/call", "params": {"name": "spotify_" + name, "arguments": args}})
        if status != 200 or "result" not in reply:
            raise APIError("tool_unavailable", 502)
        result = reply["result"]
        data = json.loads(result["content"][0]["text"])
        return not result.get("isError", False), data

    def spotify_health(self):
        with OPENER.open(f"http://127.0.0.1:{self.spotify_port}/health", timeout=5) as response:
            return json.load(response)


class PlatformWorker(Worker):
    def __init__(self, user, headers, base):
        super().__init__(user, Path('/unused'), 0, 0)
        self.headers, self.endpoint = headers, base

    def request(self, path, method="GET", body=None, timeout=150):
        raw = json.dumps(body, ensure_ascii=False).encode() if body is not None else None
        req = urllib.request.Request(self.endpoint + '/api/runtime/v1/proxy', data=raw, method=method,
            headers={**self.headers, 'X-RDA-Runtime-Path': path, 'Content-Type': 'application/json'})
        try:
            return OPENER.open(req, timeout=timeout)
        except urllib.error.HTTPError as error:
            return error

    def spotify_health(self):
        status, value = self.json('/runtime/spotify-health')
        if status != 200:
            raise APIError('spotify_unavailable', 503)
        return value


class PlatformWorkers:
    """The authenticated application delegates ownership; no Docker credentials in this gateway."""
    def __init__(self, store):
        self.store = store
        self.base = os.environ['RDA_RUNTIME_URL'].rstrip('/')
        parsed = urllib.parse.urlparse(self.base)
        if parsed.scheme not in {'https', 'http'} or parsed.username or parsed.password or parsed.path not in {'', '/'}:
            raise ValueError('invalid_runtime_url')
        if parsed.scheme == 'http' and parsed.hostname not in {'127.0.0.1', 'localhost', 'rda-runtime', 'host.docker.internal'}:
            raise ValueError('runtime_requires_tls')
        self.key = Path(os.environ['RDA_RUNTIME_KEY_FILE']).read_text().strip()
        if len(self.key) < 32:
            raise ValueError('invalid_runtime_service_key')
        self.legacy = None
        self.legacy_lock = threading.RLock()

    @contextmanager
    def local_lease(self, user):
        if os.getenv('RDA_RUNTIME_LEGACY_FALLBACK') != 'true':
            raise APIError('link_rda_before_compute_migration', 409)
        with self.legacy_lock:
            if self.legacy is None:
                self.legacy = Workers(self.store)
        with self.legacy.lease(user) as worker:
            yield worker

    @contextmanager
    def lease(self, user):
        binding = self.store.sso_binding(user['id'])
        if not binding:
            with self.local_lease(user) as worker:
                yield worker
            return
        ready_file = os.getenv('RDA_RUNTIME_READY_USERS_FILE')
        if ready_file:
            ready = json.loads(Path(ready_file).read_text())
            local = self.store.root / 'users' / identifier(user['id'])
            has_data = any((local / name).is_dir() and any((local / name).iterdir()) for name in ['daemon', 'spotify'])
            if has_data and user['id'] not in ready:
                with self.local_lease(user) as worker:
                    yield worker
                return
        identity = {'issuer': binding['issuer'], 'id': binding['platform_user_id'], 'role': 'member'}
        owner = base64.urlsafe_b64encode(json.dumps(identity).encode()).decode().rstrip('=')
        headers = {'X-RDA-Application': 'euterpe', 'X-RDA-Runtime-Key': self.key, 'X-RDA-Runtime-Owner': owner,
                   'X-RDA-Runtime-Connection': 'spotify', 'Content-Type': 'application/json'}
        request = urllib.request.Request(self.base + '/api/runtime/v1/instance', method='POST', headers=headers,
            data=json.dumps({'inputs': {'DAEMON_KEY': user['daemon_key'], 'SPOTIFY_KEY': user['spotify_key']}}).encode())
        try:
            with OPENER.open(request, timeout=100) as response:
                json.load(response)
        except (OSError, ValueError):
            raise APIError('compute_unavailable', 503) from None
        yield PlatformWorker(user, headers, self.base)

    def close(self):
        if self.legacy is not None:
            self.legacy.close()


class Workers:
    def __init__(self, store):
        self.store = store
        self.lock = threading.RLock()
        self.items = {}
        self.stopping = threading.Event()
        self.root = store.root / "users"
        self.root.mkdir(exist_ok=True, mode=0o711)
        os.chmod(self.root, 0o711)
        self.limit = int(os.getenv("WEB_MAX_ACTIVE_USERS", "16"))
        threading.Thread(target=self.reaper, daemon=True).start()

    def folder(self, user):
        root = self.root / identifier(user["id"])
        uid = 20000 + user["number"]
        for path in [root, root / "daemon", root / "spotify", root / "tmp"]:
            path.mkdir(exist_ok=True, mode=0o700)
            os.chmod(path, 0o700)
            if os.name == "posix" and os.geteuid() == 0:
                os.chown(path, uid, uid)
        return root

    @staticmethod
    def port():
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return sock.getsockname()[1]

    def start(self, user):
        root = self.folder(user)
        port, spotify_port = self.port(), self.port()
        while port == spotify_port:
            spotify_port = self.port()
        worker = Worker(user, root, port, spotify_port)
        env = {"PATH": os.defpath, "HOME": str(root), "LANG": "C.UTF-8", "TMPDIR": str(root / "tmp"), "TOKIO_WORKER_THREADS": "2", "GOMAXPROCS": "2"}
        identity = {}
        if os.name == "posix":
            if os.geteuid() != 0:
                raise APIError("worker_isolation_requires_container", 503)
            uid = 20000 + user["number"]
            identity = {"user": uid, "group": uid, "extra_groups": []}
        elif os.getenv("WEB_ALLOW_UNISOLATED_DEV") != "1":
            raise APIError("use_docker_for_user_isolation", 503)
        spotify_env = {**env, "SPOTIFY_STATE_FILE": str(root / "spotify/state.json"), "SPOTIFY_PAIRING_ENABLED": "true", "SPOTIFY_SERVICE_SECRET": user["spotify_key"], "LISTEN_ADDR": f"127.0.0.1:{spotify_port}"}
        daemon_env = {**env, "HOST": "127.0.0.1", "PORT": str(port), "EUTERPE_DATA_DIR": str(root / "daemon"), "WS_SECRET": user["daemon_key"], "EUTERPE_HEADLESS_URL": f"http://127.0.0.1:{spotify_port}", "EUTERPE_HEADLESS_SECRET": user["spotify_key"], "EUTERPE_MUTATION_POLICY": "confirm", "EUTERPE_SUGGESTIONS": "false"}
        try:
            for binary, child_env in [(os.getenv("WEB_SPOTIFY_BIN", "/usr/local/bin/euterpe-headless"), spotify_env), (os.getenv("WEB_DAEMON_BIN", "/usr/local/bin/euterpe"), daemon_env)]:
                with (root / ("spotify.log" if binary.endswith("headless") else "daemon.log")).open("ab") as logs:
                    worker.processes.append(subprocess.Popen([binary] + ([] if binary.endswith("headless") else ["serve"]), env=child_env, cwd=root, stdout=logs, stderr=logs, start_new_session=True, **identity))
            deadline = time.monotonic() + 65
            while time.monotonic() < deadline:
                if any(p.poll() is not None for p in worker.processes):
                    break
                try:
                    with OPENER.open(f"http://127.0.0.1:{spotify_port}/health", timeout=1) as response:
                        spotify_ready = response.status == 200
                    if spotify_ready and worker.json("/health")[0] == 200:
                        return worker
                except (OSError, APIError):
                    pass
                time.sleep(0.1)
            raise APIError("worker_start_failed", 503)
        except Exception:
            self.stop(worker)
            raise

    @contextmanager
    def lease(self, user):
        with self.lock:
            worker = self.items.get(user["id"])
            if worker and any(p.poll() is not None for p in worker.processes):
                self.stop(worker)
                self.items.pop(user["id"], None)
                worker = None
            if not worker:
                if len(self.items) >= self.limit:
                    raise APIError("server_capacity_busy", 503)
                worker = self.start(user)
                self.items[user["id"]] = worker
            worker.requests += 1
            worker.used = time.monotonic()
        try:
            yield worker
        finally:
            with self.lock:
                worker.requests -= 1
                worker.used = time.monotonic()

    @staticmethod
    def stop(worker):
        for process in worker.processes:
            if process.poll() is None:
                try:
                    process.terminate()
                except ProcessLookupError:
                    pass
        for process in worker.processes:
            try:
                process.wait(timeout=4)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=4)

    def reaper(self):
        while not self.stopping.wait(30):
            with self.lock:
                for user_id, worker in list(self.items.items()):
                    if worker.requests == 0 and time.monotonic() - worker.used > 1200:
                        self.stop(worker)
                        del self.items[user_id]

    def close(self):
        self.stopping.set()
        with self.lock:
            for worker in self.items.values():
                self.stop(worker)
            self.items.clear()


class Application:
    def __init__(self, root, workers=None):
        self.store = Store(root)
        self.oauth = McpOAuth(self.store, APIError)
        with self.store.db() as c:
            c.execute("UPDATE jobs SET status='interrupted',result=? WHERE status IN ('pending','running')", (json.dumps({"code": "operation_interrupted_verify_state"}),))
        self.workers = workers or (PlatformWorkers(self.store) if os.getenv('RDA_RUNTIME_URL') else Workers(self.store))
        self.lock = threading.RLock()
        self.chat_locks = {}
        self.login_attempts = {}
        self.seen_proposals = set()
        self.sso = None
        self.ai_client = RdaAiClient()
        if os.getenv('WEB_SSO_ENABLED') == 'true':
            self.sso = RdaSso(origin=os.environ['WEB_PUBLIC_ORIGIN'], client_id=os.environ['WEB_SSO_CLIENT_ID'],
                project_id=os.environ['RDA_SSO_PROJECT_ID'], secret_file=os.getenv('WEB_SSO_CLIENT_SECRET_FILE'))

    def login_limit(self, address):
        now = time.monotonic()
        with self.lock:
            old = [t for t in self.login_attempts.get(address, []) if now - t < 600]
            if len(old) >= 20:
                raise APIError("too_many_login_attempts", 429)
            self.login_attempts[address] = old + [now]

    def action(self, user, name, args):
        if name not in WRITE_TOOLS:
            raise APIError("unsupported_action")
        job_id = str(uuid.uuid4())
        with self.store.db() as c:
            c.execute("BEGIN IMMEDIATE")
            busy = c.execute("SELECT count(*) FROM jobs WHERE user_id=? AND status IN ('pending','running')", (user["id"],)).fetchone()[0]
            if busy:
                raise APIError("another_change_is_pending", 409)
            c.execute("INSERT INTO jobs VALUES (?,?,?,?,?,?,?)", (job_id, user["id"], name, json.dumps(args), "pending", None, time.time()))
        def run():
            status, data = "failed", {"code": "operation_failed"}
            try:
                with self.workers.lease(user) as worker:
                    ok, data = worker.tool(name, args)
                    status = "succeeded" if ok else "failed"
            except APIError as error:
                data = {"code": error.code}
            except Exception:
                data = {"code": "operation_interrupted_verify_state"}
            with self.store.db() as c:
                c.execute("UPDATE jobs SET status=?,result=? WHERE id=?", (status, json.dumps(data), job_id))
            self.store.activity(user["id"], "mutation", name, status, {"tool": name, "arguments": args, "result": data})
        threading.Thread(target=run, daemon=True).start()
        return {"id": job_id, "status": "pending", "tool": name}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "Euterpe"

    @property
    def app(self):
        return self.server.app

    def log_message(self, *_):
        # Access-link tickets, cookies, chat text and provider keys are never logged.
        pass

    def common_headers(self):
        # Routes such as logout/link need no JSON fields. Close an HTTP/1.1
        # connection when its body was not consumed, so bytes cannot become the
        # next request line (e.g. "{}GET" returning an HTML 501 response).
        if self.command not in {'GET', 'HEAD', 'OPTIONS'} and not getattr(self, '_body_consumed', False):
            self.send_header('Connection', 'close')
            self.close_connection = True
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        # Same-origin keeps the Origin header on native consent forms. A
        # no-referrer policy makes Chromium send Origin: null on form POST.
        self.send_header("Referrer-Policy", "same-origin" if getattr(self, '_oauth_form_target', '') else "no-referrer")
        if os.getenv('WEB_REQUIRE_HTTPS') == 'true':
            self.send_header('Strict-Transport-Security', 'max-age=31536000')
        form_target = getattr(self, '_oauth_form_target', '')
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" + (' ' + form_target if form_target else ''))

    def cookie(self, token, clear=False):
        same_site = 'Lax' if self.app.sso else 'Strict'
        value = f"{COOKIE}={token}; Path=/; HttpOnly; SameSite={same_site}; Max-Age={0 if clear else SESSION_SECONDS}"
        if os.getenv("WEB_COOKIE_SECURE") == "1":
            value += "; Secure"
        return value

    def reply(self, data, status=200, cookie=None):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.common_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        if status == 401 and urllib.parse.urlsplit(self.path).path == '/mcp':
            self.send_header('WWW-Authenticate', 'Bearer realm="euterpe-mcp", resource_metadata="' + self.oauth_origin() + '/.well-known/oauth-protected-resource/mcp"')
        if cookie:
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(raw)

    def body(self):
        if self.headers.get_content_type() != "application/json":
            raise APIError("json_required", 415)
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 < size <= 1048576:
                raise APIError("request_too_large", 413)
            raw = self.rfile.read(size)
            self._body_consumed = len(raw) == size
            body = json.loads(raw)
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except (ValueError, UnicodeError):
            raise APIError("invalid_json") from None

    def origin(self):
        origin = self.headers.get("Origin")
        expected = os.getenv("WEB_PUBLIC_ORIGIN", "").rstrip("/")
        allowed = {expected} if expected else {"http://" + self.headers.get("Host", ""), "https://" + self.headers.get("Host", "")}
        if origin and origin.rstrip("/") not in allowed:
            raise APIError("origin_rejected", 403)

    def authenticated(self, csrf=None):
        user, token = self.app.store.authenticate(self.headers.get("Cookie"))
        binding = self.app.store.sso_binding(user['id'])
        if binding:
            with self.app.store.db() as c:
                marked = c.execute('SELECT subject FROM sso_sessions WHERE hash=?', (digest(token),)).fetchone()
            if not self.app.sso or not marked or marked['subject'] != binding['subject']:
                raise APIError('rda_sso_required', 401)
            self.app.sso.verify_session(token, binding['subject'])
        if self.command not in {"GET", "HEAD"}:
            self.origin()
            if not hmac.compare_digest(csrf if csrf is not None else self.headers.get("X-CSRF-Token", ""), self.app.store.csrf(token)):
                raise APIError("csrf_rejected", 403)
        return user, token

    def oauth_origin(self):
        origin = os.getenv('WEB_PUBLIC_ORIGIN', '').rstrip('/')
        if not origin:
            host, port = self.server.server_address[:2]
            if host != '127.0.0.1':
                raise APIError('oauth_origin_not_configured', 503)
            origin = f'http://127.0.0.1:{port}'
        parsed = urllib.parse.urlsplit(origin)
        if (parsed.scheme != 'https' and not (parsed.scheme == 'http' and parsed.hostname == '127.0.0.1')
                or not parsed.hostname or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
                or re.search(r'[\s\x00-\x1f\x7f"<>]', origin)):
            raise APIError('oauth_origin_not_configured', 503)
        return origin

    @staticmethod
    def oauth_params(raw):
        try:
            parsed = urllib.parse.parse_qs(raw, keep_blank_values=True, max_num_fields=30, errors='strict')
            if any(len(values) != 1 for values in parsed.values()):
                raise ValueError()
            return {key: values[0] for key, values in parsed.items()}
        except (ValueError, UnicodeError):
            raise APIError('invalid_request') from None

    def oauth_body(self):
        if self.headers.get_content_type() == 'application/json':
            body = self.body()
            if any(not isinstance(value, str) for value in body.values()):
                raise APIError('invalid_request')
            return body
        if self.headers.get_content_type() != 'application/x-www-form-urlencoded':
            raise APIError('form_required', 415)
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 16384:
                raise APIError('request_too_large', 413)
            raw = self.rfile.read(size)
            self._body_consumed = len(raw) == size
            return self.oauth_params(raw.decode('utf-8'))
        except (ValueError, UnicodeError):
            raise APIError('invalid_request') from None

    def redirect(self, location, cookie=None):
        self.send_response(303)
        self.common_headers()
        self.send_header('Location', location)
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def oauth_route(self, path, query):
        origin = self.oauth_origin()
        if self.command == 'GET' and path in {'/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'}:
            return self.reply({'resource': origin + '/mcp', 'authorization_servers': [origin],
                'bearer_methods_supported': ['header'], 'scopes_supported': ['read', 'write'], 'resource_name': 'Euterpe MCP'})
        if self.command == 'GET' and path == '/.well-known/oauth-authorization-server':
            return self.reply({'issuer': origin, 'authorization_endpoint': origin + '/oauth/authorize',
                'token_endpoint': origin + '/oauth/token', 'registration_endpoint': origin + '/oauth/register',
                'revocation_endpoint': origin + '/oauth/revoke', 'response_types_supported': ['code'],
                'grant_types_supported': ['authorization_code', 'refresh_token'],
                'token_endpoint_auth_methods_supported': ['none'], 'code_challenge_methods_supported': ['S256'],
                'scopes_supported': ['read', 'write'], 'authorization_response_iss_parameter_supported': True})
        if path == '/oauth/register' and self.command == 'POST':
            self.origin()
            self.app.login_limit('oauth-register:' + self.client_address[0])
            return self.reply(self.app.oauth.register(self.body()), 201)
        if path in {'/oauth/token', '/oauth/revoke'} and self.command == 'POST':
            self.origin()
            params = self.oauth_body()
            if self.headers.get('Authorization') or params.get('client_secret'):
                raise APIError('invalid_client', 401)
            if path.endswith('/token'):
                return self.reply(self.app.oauth.exchange(params, origin))
            self.app.oauth.revoke(params)
            return self.reply({})
        if path != '/oauth/authorize' or self.command not in {'GET', 'POST'}:
            raise APIError('method_not_allowed', 405)
        if self.command == 'POST':
            params = self.oauth_body()
            user, session = self.authenticated(params.get('csrf', ''))
            if params.get('decision') not in {'approve', 'deny'}:
                raise APIError('invalid_request')
            result = self.app.oauth.consent(params.get('transaction', ''), user['id'], session, params['decision'] == 'approve')
            target = result.pop('redirect_uri')
            callback = urllib.parse.urlsplit(target)
            self._oauth_form_target = callback.scheme + '://' + callback.netloc
            return self.redirect(target + ('&' if '?' in target else '?') + urllib.parse.urlencode(result))
        params = self.oauth_params(query)
        if 'transaction' in params:
            if set(params) != {'transaction'}:
                raise APIError('invalid_request')
            transaction = params['transaction']
            self.app.oauth.pending(transaction)
        else:
            self.app.login_limit('oauth-authorize:' + self.client_address[0])
            transaction = self.app.oauth.begin(params, origin)
        try:
            user, session = self.authenticated()
        except (APIError, SsoError) as error:
            if error.status != 401 or not self.app.sso:
                raise
            self.app.login_limit('oauth-login:' + self.client_address[0])
            url, state = self.app.sso.start({'mcp_transaction': transaction})
            cookie = f'euterpe_sso_state={state}; Path=/api/account/sso; HttpOnly; SameSite=Lax; Max-Age=600'
            if self.app.sso.cookie_secure:
                cookie += '; Secure'
            return self.redirect(url, cookie)
        data = self.app.oauth.bind(transaction, user['id'], session)
        escape = html.escape
        permissions = ('Ler sua biblioteca e alterar playlists conforme suas preferências de autorização no Euterpe. Se a confirmação estiver desativada, alterações poderão ser executadas automaticamente.'
                       if 'write' in data['scope'].split() else 'Consultar sua biblioteca, playlists e buscar músicas. Sem permissão para alterar playlists.')
        callback_host = urllib.parse.urlsplit(data['redirect_uri']).netloc
        callback = urllib.parse.urlsplit(data['redirect_uri'])
        # Chromium checks form-action against the final 303 destination too.
        # This page permits only its own origin and this registered callback.
        self._oauth_form_target = callback.scheme + '://' + callback.netloc
        page = f'''<!doctype html><html lang="pt-BR" data-theme="dark"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Autorizar aplicativo — Euterpe</title><link rel="stylesheet" href="/fonts.css">
<link rel="stylesheet" href="/rda-tokens.css"><link rel="stylesheet" href="/rda-ds.css">
<link rel="stylesheet" href="/oauth.css"></head><body class="rda-body">
<main class="oauth-consent" aria-labelledby="consent-title"><p class="oauth-eyebrow">Euterpe · Acesso MCP</p>
<h1 id="consent-title">Autorizar aplicativo</h1>
<p><strong class="oauth-client">{escape(data['client_name'])}</strong> solicita acesso à sua conta Euterpe.</p>
<dl><dt>Conta</dt><dd>{escape(user['display_name'])} <span>({escape(user['username'])})</span></dd>
<dt>Permissões solicitadas</dt><dd>{permissions}</dd>
<dt>Destino da autorização</dt><dd>{escape(callback_host)}</dd></dl>
<p>O nome do aplicativo é informado por quem o registrou. Autorize apenas se você iniciou esta conexão e reconhece o destino.</p>
<p>Você pode revogar este acesso em Ajustes → Acesso remoto MCP. A conexão poderá retomar seu compute mesmo com a interface fechada.</p>
<form method="post" action="/oauth/authorize">
<input type="hidden" name="transaction" value="{escape(transaction)}">
<input type="hidden" name="csrf" value="{escape(self.app.store.csrf(session))}">
<div class="oauth-actions"><button class="rda-button rda-button--md" data-color="secondary" name="decision" value="deny">Cancelar</button>
<button class="rda-button rda-button--md" data-color="brand" name="decision" value="approve">Autorizar acesso</button></div>
</form></main></body></html>'''.encode()
        self.send_response(200)
        self.common_headers()
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def remote_mcp(self):
        self.origin()
        user, scope = self.app.store.authenticate_mcp(self.headers.get('Authorization'))
        if self.command != 'POST':
            self.send_response(405)
            self.common_headers()
            self.send_header('Allow', 'POST')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        version = self.headers.get('MCP-Protocol-Version', '2025-03-26')
        if version not in {'2025-03-26', '2025-06-18', '2025-11-25'}:
            raise APIError('unsupported_protocol_version')
        accept = self.headers.get('Accept', '')
        if 'application/json' not in accept or 'text/event-stream' not in accept:
            raise APIError('mcp_accept_required', 406)
        body = self.body()
        request_id = body.get('id')
        def error(code, message):
            return self.reply({'jsonrpc': '2.0', 'id': request_id, 'error': {'code': code, 'message': message}})
        method, params = body.get('method'), body.get('params', {})
        if body.get('jsonrpc') != '2.0' or not isinstance(method, str) or not isinstance(params, dict):
            return error(-32600, 'Invalid Request')
        if 'id' not in body:
            if method not in {'notifications/initialized', 'notifications/cancelled'}:
                raise APIError('unsupported_notification')
            self.send_response(202)
            self.common_headers()
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if type(request_id) not in (str, int):
            return error(-32600, 'Invalid request id')
        allowed_methods = {'initialize', 'ping', 'tools/list', 'tools/call', 'resources/list',
                           'resources/read', 'resources/templates/list', 'prompts/list', 'prompts/get'}
        if method not in allowed_methods:
            return error(-32601, 'Method not found')
        if method == 'initialize':
            requested = params.get('protocolVersion')
            info = params.get('clientInfo')
            if (not isinstance(requested, str) or not requested or not isinstance(params.get('capabilities'), dict)
                    or not isinstance(info, dict) or not all(isinstance(info.get(key), str) and info[key] for key in ('name', 'version'))):
                return error(-32602, 'Invalid initialize parameters')
            negotiated = requested if requested in ('2025-03-26', '2025-06-18', '2025-11-25') else '2025-11-25'
            # Authenticate and validate the handshake before resuming this owner's
            # compute. No UI cookie or browser heartbeat is required afterwards.
            with self.app.workers.lease(user):
                pass
            return self.reply({'jsonrpc': '2.0', 'id': request_id, 'result': {
                'protocolVersion': negotiated, 'serverInfo': {'name': 'euterpe-remote', 'version': '1.0.0'},
                'capabilities': {'tools': {'listChanged': False}, 'resources': {'subscribe': False, 'listChanged': False}, 'prompts': {'listChanged': False}},
                'instructions': 'Acesso Spotify pessoal. Leia antes de escrever. Escritas seguem a preferência de autorização da conta (aprovação por padrão); nunca repita uma escrita de resultado incerto.'}})
        if method == 'ping':
            return self.reply({'jsonrpc': '2.0', 'id': request_id, 'result': {}})
        allowed_tools = {'spotify_' + name for name in READ_TOOLS | (WRITE_TOOLS if scope == 'write' else set())}
        if method == 'tools/call':
            if not isinstance(params.get('name'), str) or params['name'] not in allowed_tools:
                return error(-32602, 'Tool unavailable for this token')
            if not isinstance(params.get('arguments', {}), dict):
                return error(-32602, 'Invalid arguments')
            # Never take the caller's flag as the owner's operation preference.
            body = {**body, 'params': {**params, '_requireConfirmation': True}}
        with self.app.workers.lease(user) as worker:
            if method == 'tools/call' and params.get('name') in {'spotify_' + name for name in WRITE_TOOLS}:
                settings_status, settings = worker.json('/settings')
                if settings_status != 200 or not isinstance(settings, dict):
                    raise APIError('operation_policy_unavailable', 503)
                policy = settings.get('settings', {}).get('mutationPolicy', 'confirm')
                body['params']['_requireConfirmation'] = policy != 'allow'
            status, reply = worker.json('/mcp', 'POST', body)
        if status != 200 or not isinstance(reply, dict):
            raise APIError('agent_unavailable', 502)
        if method == 'tools/list' and isinstance(reply.get('result'), dict):
            reply['result']['tools'] = [tool for tool in reply['result'].get('tools', []) if tool.get('name') in allowed_tools]
        return self.reply(reply)

    def oauth_problem(self, error):
        completed = error.code == 'authorization_already_completed'
        title = 'Autorização já enviada' if completed else 'Solicitação de conexão encerrada'
        message = ('A autorização desta conexão já foi enviada. Volte ao aplicativo em que você iniciou a conexão.'
                   if completed else 'Esta solicitação expirou ou já foi utilizada. Volte ao aplicativo e inicie a conexão novamente.')
        page = f'''<!doctype html><html lang="pt-BR" data-theme="dark"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>{title} — Euterpe</title>
<link rel="stylesheet" href="/fonts.css"><link rel="stylesheet" href="/rda-tokens.css">
<link rel="stylesheet" href="/rda-ds.css"><link rel="stylesheet" href="/oauth.css"></head>
<body class="rda-body"><main class="oauth-consent"><p class="oauth-eyebrow">Euterpe · Acesso MCP</p>
<h1>{title}</h1><p>{message}</p><a class="rda-button rda-button--md" data-color="secondary" href="/">Abrir Euterpe</a>
</main></body></html>'''.encode()
        self.send_response(error.status)
        self.common_headers()
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_GET(self):
        self.handle_route()

    def do_POST(self):
        self.handle_route()

    def do_PUT(self):
        self.handle_route()

    def do_PATCH(self):
        self.handle_route()

    def do_DELETE(self):
        self.handle_route()

    def do_OPTIONS(self):
        self.reply({"error": "origin_rejected"}, 403)

    def handle_route(self):
        self._body_consumed = False
        self._oauth_form_target = ''
        try:
            self.route()
        except APIError as error:
            if (urllib.parse.urlsplit(self.path).path == '/oauth/authorize' and 'text/html' in self.headers.get('Accept', '')
                    and error.code in {'invalid_authorization_request', 'authorization_already_completed'}):
                return self.oauth_problem(error)
            self.reply({"error": error.code}, error.status)
        except SsoError as error:
            self.reply({"error": error.code}, error.status)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception:
            self.reply({"error": "request_failed"}, 500)

    def route(self):
        parsed = urllib.parse.urlsplit(self.path)
        path = urllib.parse.unquote(parsed.path)
        if ".." in path or "\\" in path or "\x00" in path:
            raise APIError("invalid_path")
        if os.getenv('WEB_REQUIRE_HTTPS') == 'true' and self.headers.get('X-Forwarded-Proto', '').split(',')[0].strip() == 'http':
            origin = os.getenv('WEB_PUBLIC_ORIGIN', '').rstrip('/')
            if not origin.startswith('https://'):
                raise APIError('https_origin_required', 503)
            self.send_response(308)
            self.common_headers()
            self.send_header('Location', origin + '/' + parsed.path.lstrip('/') + ('?' + parsed.query if parsed.query else ''))
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if self.command == "GET" and path.startswith("/access/"):
            token = self.app.store.consume_ticket(path.split("/")[-1])
            self.send_response(303)
            self.common_headers()
            self.send_header("Set-Cookie", self.cookie(token))
            self.send_header("Location", "/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if path == "/health" and self.command == "GET":
            return self.reply({"ok": True, "app": "euterpe-web"})
        if path == '/mcp':
            return self.remote_mcp()
        if path.startswith('/oauth/') or path.startswith('/.well-known/oauth-'):
            return self.oauth_route(path, parsed.query)
        if path == '/api/account/sso/config' and self.command == 'GET':
            return self.reply({'enabled': bool(self.app.sso), 'loginUrl': '/api/account/sso/login', 'localLoginEnabled': os.getenv('WEB_LOCAL_LOGIN_ENABLED', 'true') != 'false'})
        if path in {'/api/account/sso/login', '/api/account/sso/link'}:
            if not self.app.sso:
                raise APIError('sso_not_configured', 503)
            link = None
            if path.endswith('/link'):
                if self.command != 'POST':
                    raise APIError('method_not_allowed', 405)
                local_user, local_token = self.authenticated()
                link = {'user_id': local_user['id'], 'session_hash': digest(local_token)}
            elif self.command != 'GET':
                raise APIError('method_not_allowed', 405)
            self.app.login_limit(self.client_address[0])
            url, transaction = self.app.sso.start(link)
            transaction_cookie = f'euterpe_sso_state={transaction}; Path=/api/account/sso; HttpOnly; SameSite=Lax; Max-Age=600'
            if self.app.sso.cookie_secure:
                transaction_cookie += '; Secure'
            if link:
                return self.reply({'url': url}, cookie=transaction_cookie)
            self.send_response(303); self.common_headers()
            self.send_header('Location', url); self.send_header('Set-Cookie', transaction_cookie)
            self.send_header('Content-Length', '0'); self.end_headers(); return
        if path == '/api/account/sso/callback' and self.command == 'GET':
            if not self.app.sso:
                raise APIError('sso_not_configured', 503)
            cookies = SimpleCookie(); cookies.load(self.headers.get('Cookie', ''))
            query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            if any(len(value) != 1 for value in query.values()):
                raise APIError('invalid_oauth_callback')
            identity = self.app.sso.finish({key: value[0] for key, value in query.items()}, cookies['euterpe_sso_state'].value if 'euterpe_sso_state' in cookies else '')
            link = identity['link'] or {}
            transaction = link.get('mcp_transaction')
            if transaction:
                self.app.oauth.pending(transaction)
            user = self.app.store.bind_sso(identity['profile'], link.get('user_id'), link.get('session_hash'))
            token = self.app.store.issue_session(user['id'])
            with self.app.store.db() as c:
                c.execute('UPDATE sessions SET expires=? WHERE hash=?', (identity['expires'], digest(token)))
                c.execute('INSERT INTO sso_sessions VALUES (?,?)', (digest(token), identity['profile']['sub']))
            self.app.sso.remember(token, identity)
            self.send_response(303); self.common_headers()
            self.send_header('Set-Cookie', 'euterpe_sso_state=; Path=/api/account/sso; HttpOnly; SameSite=Lax; Max-Age=0' + ('; Secure' if self.app.sso.cookie_secure else ''))
            self.send_header('Set-Cookie', self.cookie(token))
            self.send_header('Location', '/oauth/authorize?' + urllib.parse.urlencode({'transaction': transaction}) if transaction else '/')
            self.send_header('Content-Length', '0'); self.end_headers(); return
        if path in {"/api/account/login", "/api/account/register"} and self.command == "POST":
            self.origin()
            if path.endswith('/login') and os.getenv('WEB_LOCAL_LOGIN_ENABLED', 'true') == 'false':
                raise APIError('use_rda_sso_login', 403)
            self.app.login_limit(self.client_address[0])
            body = self.body()
            if path.endswith("register"):
                if self.app.sso:
                    raise APIError('use_rda_sso_registration', 403)
                if os.getenv("WEB_REGISTRATION", "open") != "open":
                    raise APIError("registration_closed", 403)
                user = self.app.store.register(body)
            else:
                user = self.app.store.login(body)
            token = self.app.store.issue_session(user["id"])
            return self.reply({"user": self.public_user(user), "csrf": self.app.store.csrf(token)}, cookie=self.cookie(token))
        if not path.startswith("/api/"):
            if self.command != "GET":
                raise APIError("not_found", 404)
            asset = "index.html" if path == "/" else path.lstrip("/")
            target_file = (STATIC / asset).resolve()
            if not target_file.is_file() or not str(target_file).startswith(str(STATIC.resolve())):
                raise APIError("not_found", 404)
            raw = target_file.read_bytes()
            self.send_response(200)
            self.common_headers()
            self.send_header("Content-Type", mimetypes.guess_type(asset)[0] or "application/octet-stream")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return

        user, token = self.authenticated()
        if path == '/api/mcp/tokens':
            if self.command == 'GET':
                return self.reply({'tokens': self.app.store.mcp_tokens(user['id']), 'endpoint': '/mcp'})
            if self.command == 'POST':
                return self.reply(self.app.store.issue_mcp_token(user['id'], self.body()), 201)
        if path.startswith('/api/mcp/tokens/') and self.command == 'DELETE':
            self.app.store.revoke_mcp_token(user['id'], identifier(path.rsplit('/', 1)[-1]))
            return self.reply({'ok': True})
        user_id = user["id"]
        if path == "/api/me" and self.command == "GET":
            return self.reply({"user": self.public_user(user), "csrf": self.app.store.csrf(token), 'ssoLinked': bool(self.app.store.sso_binding(user_id))})
        if path == "/api/account/logout" and self.command == "POST":
            if self.app.sso:
                self.app.sso.forget(token)
            with self.app.store.db() as c:
                c.execute("DELETE FROM sessions WHERE hash=?", (digest(token),))
            return self.reply({"ok": True}, cookie=self.cookie("", True))
        if path == "/api/conversations":
            if self.command == "GET":
                with self.app.store.db() as c:
                    rows = [dict(row) for row in c.execute("SELECT id,title,created,updated FROM conversations WHERE user_id=? ORDER BY updated DESC LIMIT 200", (user_id,))]
                return self.reply({"conversations": rows})
            if self.command == "POST":
                body = self.body()
                conversation_id, now = str(uuid.uuid4()), time.time()
                title = str(body.get("title", "Nova conversa")).strip()[:100] or "Nova conversa"
                with self.app.store.db() as c:
                    c.execute("INSERT INTO conversations VALUES (?,?,?,?,?)", (conversation_id, user_id, title, now, now))
                return self.reply({"id": conversation_id, "title": title, "messages": []}, 201)
        if path.startswith("/api/conversations/") and path.endswith("/workbench") and self.command in {"GET","POST"}:
            conversation_id = identifier(path.split("/")[-2])
            self.app.store.conversation(user_id, conversation_id)
            body = self.body() if self.command == "POST" else None
            with self.app.workers.lease(user) as worker:
                status, data = worker.json("/workbench/" + conversation_id, self.command, body)
            return self.reply(data, status)
        if path.startswith("/api/conversations/") and path.endswith("/audit") and self.command == "GET":
            conversation_id = identifier(path.split("/")[-2])
            conversation = self.app.store.conversation(user_id, conversation_id)
            with self.app.store.db() as c:
                events = [dict(row) for row in c.execute(
                    "SELECT id,run_id,event,payload,created FROM chat_audit WHERE conversation_id=? ORDER BY id", (conversation_id,))]
            for event in events:
                event["payload"] = json.loads(event["payload"])
                event["source"] = "gateway"
            # Only diagnostic fields are exposed: never raw logs, reasoning, headers or credentials.
            allowed = {
                "session.start": {"model"}, "session.end": {"final_length"},
                "llm.turn": {"step", "tool_calls"}, "llm.final": {"step", "length"},
                "llm.error": {"step", "code"}, "tools.available": {"names", "backend"},
                "tool.result": {"name", "ok", "code", "size", "duration_ms"},
                "context.metrics": {"before_bytes","after_bytes","estimated_input_tokens","max_input_tokens","tool_budget_tokens","archived_references"},
                "llm.response": {"step","duration_ms","input_tokens","output_tokens"},
                "operation.progress": {"operation_id","kind","status","stage","items_processed","total_items","error","updated","spotify_ms","llm_ms","input_tokens","output_tokens"},
            }
            allowed["tool.result"].update({"inline_bytes","estimated_inline_tokens","offloaded"})
            available = False
            try:
                with self.app.workers.lease(user) as worker:
                    status, logs = worker.json("/sessions/" + conversation_id)
                available = status == 200 and isinstance(logs, list)
                if available:
                    from datetime import datetime
                    for entry in logs:
                        if not isinstance(entry, dict) or entry.get("event") not in allowed:
                            continue
                        try:
                            created = datetime.fromisoformat(entry["ts"].replace("Z", "+00:00")).timestamp()
                        except (KeyError, ValueError, TypeError):
                            continue
                        payload = entry.get("payload") or {}
                        if not isinstance(payload, dict):
                            continue
                        events.append({"event": entry["event"], "created": created, "source": "agent",
                                       "payload": {k: v for k, v in payload.items() if k in allowed[entry["event"]]}})
            except Exception:
                pass  # Gateway audit and messages remain available when a worker is unavailable.
            events.sort(key=lambda e: e["created"])
            with self.app.lock:
                running = self.app.chat_locks.get(conversation_id, threading.Lock()).locked()
            return self.reply({"conversation": conversation, "events": events, "running": running, "agent_logs_available": available})
        if path.startswith("/api/conversations/"):
            conversation_id = identifier(path.rsplit("/", 1)[-1])
            conversation = self.app.store.conversation(user_id, conversation_id)
            if self.command == "GET":
                return self.reply(conversation)
            if self.command == "PATCH":
                title = str(self.body().get("title", "")).strip()[:100]
                if not title:
                    raise APIError("title_required")
                with self.app.store.db() as c:
                    c.execute("UPDATE conversations SET title=? WHERE id=? AND user_id=?", (title, conversation_id, user_id))
                return self.reply({"ok": True})
            if self.command == "DELETE":
                with self.app.lock:
                    if self.app.chat_locks.get(conversation_id, threading.Lock()).locked():
                        raise APIError("conversation_is_running", 409)
                with self.app.workers.lease(user) as worker:
                    status, _ = worker.json("/history/" + conversation_id, "DELETE")
                if status != 200:
                    raise APIError("history_erase_failed", 502)
                with self.app.store.db() as c:
                    c.execute("DELETE FROM conversations WHERE id=? AND user_id=?", (conversation_id, user_id))
                return self.reply({"ok": True})
        if path == "/api/activity" and self.command == "GET":
            with self.app.store.db() as c:
                rows = [dict(row) for row in c.execute("SELECT id,kind,title,status,data,created FROM activity WHERE user_id=? ORDER BY id DESC LIMIT 150", (user_id,))]
            for row in rows:
                row["data"] = json.loads(row["data"])
            return self.reply({"activity": rows})
        if path.startswith("/api/jobs/") and self.command == "GET":
            job_id = identifier(path.rsplit("/", 1)[-1])
            with self.app.store.db() as c:
                row = c.execute("SELECT id,tool,status,result,created FROM jobs WHERE id=? AND user_id=?", (job_id, user_id)).fetchone()
            if not row:
                raise APIError("operation_not_found", 404)
            return self.reply({**dict(row), "result": json.loads(row["result"]) if row["result"] else None})
        if path == "/api/jobs" and self.command == "GET":
            with self.app.store.db() as c:
                rows = [dict(r) for r in c.execute("SELECT id,tool,args,status FROM jobs WHERE user_id=? AND status IN ('pending','running') ORDER BY created", (user_id,))]
            for row in rows:
                row["arguments"] = json.loads(row.pop("args"))
            return self.reply({"jobs": rows})
        if path == "/api/actions" and self.command == "POST":
            body = self.body()
            args = body.get("arguments", {})
            if not isinstance(args, dict):
                raise APIError("invalid_arguments")
            return self.reply(self.app.action(user, body.get("name"), args), 202)
        if path == "/api/chat" and self.command == "POST":
            return self.chat(user, self.body())
        if path == "/api/chat/cancel" and self.command == "POST":
            conversation_id = identifier(self.body().get("conversation_id"))
            self.app.store.conversation(user_id, conversation_id)
            with self.app.workers.lease(user) as worker:
                status, data = worker.json("/chat/" + conversation_id + "/cancel", "POST", {})
            with self.app.store.db() as c:
                run = c.execute("SELECT run_id FROM chat_audit WHERE conversation_id=? AND event='request.started' ORDER BY id DESC LIMIT 1", (conversation_id,)).fetchone()
            if run:
                self.app.store.audit_event(conversation_id, run["run_id"], "cancel.requested", {"cancelled": bool(data.get("cancelled")), "status": status})
            return self.reply(data, status)

        # Editorial models catalog
        if path == "/api/editorial-models" and self.command == "GET":
            return self.reply({
                "models": EDITORIAL_MODELS,
                "dramaturgias": DRAMATURGIAS,
                "coordenadas": COORDENADAS_DIEGETICAS,
                "eixos": EIXOS_CURATORIAIS,
            })

        # Curations
        if path == "/api/curations":
            if self.command == "GET":
                return self.reply({"curations": self.app.store.curations(user_id)})
            if self.command == "POST":
                body = self.body()
                created = self.app.store.create_curation(user_id, body)
                self.app.store.activity(user_id, "curation", created["title"], "created", {"curation_id": created["id"]})
                return self.reply(created, 201)

        if path.startswith("/api/curations/"):
            parts = path.strip("/").split("/")
            if len(parts) >= 3:
                curation_id = identifier(parts[2])
                subpath = parts[3] if len(parts) > 3 else None

                if not subpath:
                    if self.command == "GET":
                        return self.reply(self.app.store.curation(user_id, curation_id))
                    if self.command in {"PUT", "PATCH"}:
                        body = self.body()
                        updated = self.app.store.update_curation(user_id, curation_id, body)
                        return self.reply(updated)
                    if self.command == "DELETE":
                        res = self.app.store.delete_curation(user_id, curation_id)
                        return self.reply(res)

                elif subpath == "workflow":
                    if self.command == "GET":
                        cur = self.app.store.curation(user_id, curation_id)
                        return self.reply({"workflow": cur.get("workflow")})
                    if self.command in {"PUT", "POST"}:
                        body = self.body()
                        res = self.app.store.save_curation_workflow(user_id, curation_id, body)
                        return self.reply(res)

                elif subpath == "execute" and self.command == "POST":
                    cur = self.app.store.curation(user_id, curation_id)
                    wf = cur.get("workflow")
                    if not wf:
                        raise APIError("workflow_not_found", 404)
                    return self.execute_curation_workflow(user, cur, wf)

                elif subpath == "dossier" and self.command == "GET":
                    cur = self.app.store.curation(user_id, curation_id)
                    dossier = self.build_curatorial_dossier(cur)
                    return self.reply(dossier)

        # RDA AI Models
        if path == "/api/ai/models" and self.command == "GET":
            models = self.app.ai_client.list_models()
            return self.reply({"models": models})

        with self.app.workers.lease(user) as worker:
            if path == "/api/tools" and self.command == "POST":
                body = self.body()
                if body.get("name") not in READ_TOOLS or not isinstance(body.get("arguments", {}), dict):
                    raise APIError("unsupported_read_tool")
                ok, data = worker.tool(body["name"], body.get("arguments", {}))
                return self.reply({"ok": ok, "data": data}, 200 if ok else 422)
            if path == "/api/status" and self.command == "GET":
                status, spotify = worker.json("/spotify/auth")
                tools = worker.spotify_health().get("supported_tools", [])
                return self.reply({"spotify": spotify, "tools": tools, "ready": status == 200})
            if path == "/api/proposals" and self.command == "GET":
                status, data = worker.json("/proposals")
                return self.reply(data, status)
            if path.startswith("/api/proposals/") and self.command == "POST":
                proposal_id = identifier(path.rsplit("/", 1)[-1])
                decision = self.body().get("decision")
                if decision not in {"approve", "reject"}:
                    raise APIError("invalid_decision")
                _, pending = worker.json("/proposals")
                proposal = next((p for p in pending.get("proposals", []) if p["proposalId"] == proposal_id), None)
                if not proposal:
                    raise APIError("proposal_expired", 404)
                status, data = worker.json("/proposals/" + proposal_id, "POST", {"decision": decision})
                if status == 200:
                    with self.app.store.db() as c:
                        audit = c.execute("SELECT a.conversation_id,a.run_id FROM chat_audit a JOIN conversations c ON c.id=a.conversation_id WHERE c.user_id=? AND a.event='proposal' AND json_extract(a.payload,'$.proposalId')=? ORDER BY a.id DESC LIMIT 1", (user_id, proposal_id)).fetchone()
                    if audit:
                        self.app.store.audit_event(audit["conversation_id"], audit["run_id"], "proposal.decision", {"proposalId": proposal_id, "decision": decision})
                    self.app.store.activity(user_id, "decision", proposal["name"], "approved" if decision == "approve" else "rejected", {"tool": proposal["name"], "arguments": proposal["args"]})
                return self.reply(data, status)
            spotify_routes = {("/api/spotify/auth", "GET"): ("/spotify/auth", "GET"), ("/api/spotify/auth/start", "POST"): ("/spotify/auth/start", "POST"), ("/api/spotify/auth", "DELETE"): ("/spotify/auth", "DELETE")}
            if (path, self.command) in spotify_routes:
                route, method = spotify_routes[(path, self.command)]
                status, data = worker.json(route, method)
                return self.reply(data, status)
            if path == "/api/settings" and self.command in {"GET", "PUT"}:
                patch = None
                if self.command == "PUT":
                    body = self.body()
                    patch = {k: v for k, v in body.items() if k in SETTING_KEYS}
                    if 'mutationPolicy' in body and (not isinstance(body['mutationPolicy'], str) or body['mutationPolicy'] not in {'confirm', 'allow'}):
                        raise APIError('invalid_operation_policy')
                    patch.update(mutationAllowlist=[], chatUpstream="")
                status, data = worker.json("/settings", self.command, patch)
                data.pop("runtime", None)
                return self.reply(data, status)
            if path == "/api/providers" and self.command in {"GET", "POST"}:
                status, data = worker.json("/providers", self.command, self.body() if self.command == "POST" else None)
                if self.command == "POST":
                    return self.reply({"ok": status == 200}, status)
                return self.reply(data, status)
            if path == "/api/models" and self.command == "GET":
                query = urllib.parse.parse_qs(parsed.query)
                clean = urllib.parse.urlencode({k: v[0] for k, v in query.items() if k in {"provider", "model"}})
                status, data = worker.json("/models?" + clean)
                return self.reply(data if status == 200 else {"ok": False, "error": "models_unavailable"}, status)
            if path == "/api/providers/test" and self.command == "POST":
                status, data = worker.json("/providers/test", "POST", self.body())
                # Backend adapter errors can contain a provider URL: never reflect keys.
                if status != 200 or not data.get("ok", data.get("report", {}).get("ok", False)):
                    return self.reply({"ok": False, "error": "provider_test_failed"}, 422)
                return self.reply({"ok": True, "latencyMs": data.get("latencyMs", data.get("report", {}).get("latencyMs"))})
        raise APIError("not_found", 404)

    @staticmethod
    def public_user(user):
        return {k: user[k] for k in ("id", "username", "display_name")}

    def chat(self, user, body):
        conversation_id = identifier(body.get("conversation_id"))
        conversation = self.app.store.conversation(user["id"], conversation_id)
        text = str(body.get("text", "")).strip()
        if not text or len(text) > 24000:
            raise APIError("invalid_message")
        with self.app.lock:
            lock = self.app.chat_locks.setdefault(conversation_id, threading.Lock())
        if not lock.acquire(blocking=False):
            raise APIError("conversation_is_running", 409)
        assistant, complete, started = "", False, False
        run_id, audit_started = str(uuid.uuid4()), time.monotonic()
        outcome = "interrupted"
        response_error = None
        tool_failed = False
        try:
            self.app.store.audit_event(conversation_id, run_id, "request.started", {"input_chars": len(text)})
            with self.app.workers.lease(user) as worker:
                upstream = worker.request("/chat", "POST", {"text": text, "sessionId": conversation_id, "locale": "pt-br"})
                if upstream.status != 200:
                    upstream.close()
                    raise APIError("chat_unavailable", 502)
                self.app.store.message(conversation_id, "user", text)
                if not conversation["messages"]:
                    with self.app.store.db() as c:
                        c.execute("UPDATE conversations SET title=? WHERE id=? AND user_id=?", (text[:65], conversation_id, user["id"]))
                self.send_response(200)
                self.common_headers()
                self.send_header("Content-Type", "text/event-stream; charset=utf-8")
                self.send_header("Connection", "close")
                self.send_header("X-Accel-Buffering", "no")
                self.end_headers()
                self.close_connection = True
                started = True
                event, lines = "message", []
                with upstream:
                    for raw in upstream:
                        line = raw.decode("utf-8").rstrip("\r\n")
                        if line.startswith("event:"):
                            event = line[6:].strip()
                        elif line.startswith("data:"):
                            lines.append(line[5:].lstrip())
                        elif not line:
                            if lines:
                                data = json.loads("\n".join(lines))
                                if event in {"status", "tool", "tool-result", "proposal", "error"}:
                                    keys = {"status", "id", "name", "proposalId", "kind", "code", "ok"}
                                    self.app.store.audit_event(conversation_id, run_id, event,
                                                              {k: v for k, v in data.items() if k in keys})
                                if event == "error":
                                    outcome = "failed"
                                    response_error = data.get("code") or "provider_error"
                                if event == "tool-result" and data.get("ok") is False:
                                    tool_failed = True
                                if event == "stream":
                                    assistant += data.get("delta", "")
                                if event == "done":
                                    if not assistant.strip():
                                        outcome = "failed"
                                        response_error = response_error or "empty_response"
                                        self.app.store.audit_event(conversation_id, run_id, "error", {"code": response_error})
                                        assistant = "Não recebi uma resposta do agente. Consulte a auditoria desta conversa para verificar a falha."
                                        self.wfile.write(f'event: error\ndata: {json.dumps({"code": response_error})}\n\nevent: stream\ndata: {json.dumps({"delta": assistant}, ensure_ascii=False)}\n\n'.encode())
                                    elif outcome != "failed":
                                        outcome = "completed"
                                    self.app.store.message(conversation_id, "assistant", assistant, error_code=response_error or ("tool_failed" if tool_failed else None))
                                    complete = True
                                packet = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n".encode()
                                self.wfile.write(packet)
                                self.wfile.flush()
                                lines, event = [], "message"
                            else:
                                self.wfile.write(b": keepalive\n\n")
                                self.wfile.flush()
                    if complete:
                        self.record_agent_activity(user, worker, conversation_id)
        except (BrokenPipeError, ConnectionResetError, TimeoutError, OSError):
            if not started:
                outcome = "failed"
                raise APIError("chat_unavailable", 502) from None
        except Exception:
            outcome = "failed"
            if not started:
                raise
            try:
                self.wfile.write(b'event: error\ndata: {"code":"chat_interrupted"}\n\n')
                self.wfile.flush()
            except OSError:
                pass
        finally:
            try:
                if not complete:
                    fallback = "A solicitação foi interrompida antes de ser concluída. Confira a auditoria antes de repetir alterações no Spotify."
                    self.app.store.message(conversation_id, "assistant", assistant or fallback, interrupted=True, error_code=response_error or "chat_interrupted")
                self.app.store.audit_event(conversation_id, run_id, "request.finished", {
                    "outcome": outcome, "duration_ms": round((time.monotonic() - audit_started) * 1000),
                    "response_chars": len(assistant),
                })
            finally:
                lock.release()

    def record_agent_activity(self, user, worker, conversation_id):
        status, events = worker.json("/sessions/" + conversation_id)
        if status != 200 or not isinstance(events, list):
            return
        for event in events:
            payload = event.get("payload") or {}
            if event.get("event") != "tool.result" or payload.get("name") not in WRITE_TOOLS:
                continue
            unique = (user["id"], conversation_id, event.get("ts"), payload["name"])
            with self.app.lock:
                if unique in self.app.seen_proposals:
                    continue
                self.app.seen_proposals.add(unique)
            self.app.store.activity(user["id"], "agent_mutation", payload["name"], "succeeded" if payload.get("ok") else "failed", {"conversation_id": conversation_id, "tool": payload["name"], "code": payload.get("code")})

    def execute_curation_workflow(self, user, curation_project, workflow):
        steps = workflow.get("steps", [])
        edges = workflow.get("edges", [])
        is_valid, order, error_msg = validate_dag(steps, edges)
        if not is_valid:
            raise APIError(error_msg or "invalid_workflow_dag", 422)

        run_id = f"run_{curation_project['id'][:8]}_{int(time.time())}"
        step_map = {s["id"]: s for s in steps}
        step_results = {}
        paused_for_approval = None

        with self.app.workers.lease(user) as worker:
            for sid in order:
                step = step_map[sid]
                kind = step.get("kind")
                role_fn = step.get("role_function", "chat")
                requires_approval = step.get("requires_approval", False)
                allowed_tools = step.get("allowed_tools", [])

                if requires_approval or kind == "approval_gate":
                    payload = {
                        "project_id": curation_project["id"],
                        "title": curation_project["title"],
                        "tracks_count": len(curation_project.get("selected_tracks", [])),
                        "tools": allowed_tools,
                    }
                    payload_hash = compute_approval_hash(user["id"], "euterpe", "publish_curation", payload)
                    paused_for_approval = {
                        "step_id": sid,
                        "approval_id": str(uuid.uuid4()),
                        "action_type": "publish_curation",
                        "payload": payload,
                        "payload_hash": payload_hash,
                    }
                    step_results[sid] = {"status": "awaiting_approval", "paused": True}
                    break

                if kind in {"research", "selection"} and allowed_tools:
                    tool_name = allowed_tools[0].replace("spotify_", "")
                    args = {}
                    if tool_name == "get_saved_tracks":
                        args = {"limit": 20}
                    elif tool_name == "search_spotify":
                        query = curation_project.get("title", "Música")
                        args = {"query": query, "types": ["track"]}
                    try:
                        ok, data = worker.tool(tool_name, args)
                        step_results[sid] = {"status": "completed", "tool": tool_name, "ok": ok, "summary": f"Executado {tool_name}"}
                    except Exception:
                        step_results[sid] = {"status": "completed", "summary": f"Inferência de {role_fn}"}
                else:
                    step_results[sid] = {"status": "completed", "summary": f"Etapa {step.get('label')} concluída ({role_fn})"}

        self.app.store.activity(
            user["id"],
            "workflow_run",
            curation_project["title"],
            "awaiting_approval" if paused_for_approval else "completed",
            {"run_id": run_id, "step_results": step_results, "paused_for_approval": paused_for_approval}
        )
        return self.reply({
            "run_id": run_id,
            "status": "awaiting_approval" if paused_for_approval else "completed",
            "step_results": step_results,
            "pending_approval": paused_for_approval,
            "topological_order": order,
        })

    def build_curatorial_dossier(self, cur):
        model_id = cur.get("editorial_model", "escuta-e-imagem-v2")
        dramaturgia_id = cur.get("dramaturgia", "montanha_russa")
        dramaturgia = next((d for d in DRAMATURGIAS if d["id"] == dramaturgia_id), DRAMATURGIAS[0])
        model = next((m for m in EDITORIAL_MODELS if m["id"] == model_id), EDITORIAL_MODELS[0])
        briefing = cur.get("briefing", {})
        tracks = cur.get("selected_tracks", [])

        md = [
            f"# Dossiê Curatorial — {cur.get('title', 'Sem título')}",
            f"**Modelo Editorial:** {model['name']} · **Dramaturgia:** {dramaturgia['name']}",
            f"**Status:** {cur.get('status', 'draft').upper()}",
            "",
            "## 1. Coordenadas Diegéticas & Território",
        ]
        for coord in COORDENADAS_DIEGETICAS:
            val = briefing.get(coord["id"], "Não especificado")
            md.append(f"- **{coord['label']}:** {val}")

        md.append("")
        md.append("## 2. Arco Dramatúrgico")
        md.append(f"{dramaturgia['description']}")
        md.append(f"Pacing: `{dramaturgia['pacing']}` · Curva de Intensidade: `{dramaturgia['arc']}`")

        md.append("")
        md.append("## 3. Sequenciamento de Faixas")
        if not tracks:
            md.append("_Nenhuma faixa selecionada até o momento._")
        else:
            for i, t in enumerate(tracks, 1):
                name = t.get("name", "Sem título")
                artist = t.get("artist") or (t.get("artists") and t["artists"][0].get("name")) or "Artista desconhecido"
                role = t.get("narrative_role") or "desenvolvimento"
                arg = t.get("argument") or "Coerência com briefing e textura tímbrica."
                md.append(f"{i}. **{name}** — {artist}")
                md.append(f"   - *Função Narrativa:* `{role}`")
                md.append(f"   - *Justificativa Curatorial:* {arg}")

        md.append("")
        md.append("## 4. Auditoria de Respiro & Governança")
        md.append(f"- Total de faixas: {len(tracks)}")
        md.append("- Confirmação Humana Spotify: **Obrigatória antes da publicação externa** (Decisão 17A)")

        return {
            "project_id": cur["id"],
            "title": cur["title"],
            "markdown": "\n".join(md),
            "model": model,
            "dramaturgia": dramaturgia,
            "briefing": briefing,
            "tracks": tracks,
        }


def make_server(root, address=("127.0.0.1", 8080), workers=None):
    server = ThreadingHTTPServer(address, Handler)
    server.daemon_threads = True
    server.app = Application(root, workers)
    return server


def main():
    os.umask(0o077)
    server = make_server(os.getenv("WEB_DATA_DIR", "/data"), (os.getenv("WEB_HOST", "0.0.0.0"), int(os.getenv("WEB_PORT", "8080"))))
    atexit.register(server.app.workers.close)
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    print("Euterpe Web ready", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
        server.app.workers.close()


if __name__ == "__main__":
    main()
