"""Authorization Code + PKCE; the canonical RDA core verifies the access token.

Never derive identity from an unverified ID-token payload, email or username.
Provider tokens remain in process memory; local account/data IDs remain stable.
"""
import base64
import hashlib
import json
from pathlib import Path
import secrets
import threading
import time
import urllib.parse
import urllib.request


class SsoError(Exception):
    def __init__(self, code="sso_login_failed", status=401):
        self.code, self.status = code, status


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


class RdaSso:
    def __init__(self, origin, client_id, project_id, secret_file=None,
                 issuer="https://id.reversodoavesso.com",
                 verify_url="https://auth.reversodoavesso.com/api/auth/verify", requester=None,
                 allow_test_loopback=False):
        self.origin, self.client_id, self.project_id = origin.rstrip("/"), client_id, project_id
        self.issuer, self.verify_url = issuer.rstrip("/"), verify_url
        self.callback = self.origin + "/api/account/sso/callback"
        self.cookie_secure = urllib.parse.urlsplit(origin).scheme == "https"
        self.secret = Path(secret_file).read_text().strip() if secret_file else None
        self.requester = requester or self._request
        self.pending, self.sessions, self.lock = {}, {}, threading.RLock()
        parsed = urllib.parse.urlsplit(self.origin)
        if not client_id or not project_id or parsed.username or parsed.password or parsed.path not in {"", "/"} or parsed.query or parsed.fragment:
            raise ValueError("Invalid RDA SSO configuration")
        if parsed.scheme != "https" and not (parsed.scheme == "http" and parsed.hostname == "127.0.0.1"):
            raise ValueError("SSO requires HTTPS or loopback")
        if self.issuer != "https://id.reversodoavesso.com" and not (allow_test_loopback and self.issuer.startswith("http://127.0.0.1:")):
            raise ValueError("Unexpected SSO issuer")
        if verify_url != "https://auth.reversodoavesso.com/api/auth/verify" and not (allow_test_loopback and verify_url.startswith("http://127.0.0.1:")):
            raise ValueError("Unexpected identity verifier")
        self.discovery = self.requester(self.issuer + "/.well-known/openid-configuration")
        if self.discovery.get("issuer") != self.issuer:
            raise ValueError("OIDC issuer mismatch")
        authority = urllib.parse.urlsplit(self.issuer).netloc
        for field in ["authorization_endpoint", "token_endpoint"]:
            endpoint = urllib.parse.urlsplit(self.discovery[field])
            if endpoint.netloc != authority or endpoint.scheme != urllib.parse.urlsplit(self.issuer).scheme:
                raise ValueError("Unexpected OIDC endpoint")

    @staticmethod
    def _request(url, body=None, headers=None):
        data = None if body is None else urllib.parse.urlencode(body).encode()
        req = urllib.request.Request(url, data=data, headers={"Accept": "application/json", **(headers or {})})
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *_args, **_kwargs):
                raise SsoError()
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=15) as response:
            if urllib.parse.urlsplit(response.url).netloc != urllib.parse.urlsplit(url).netloc:
                raise SsoError()
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise SsoError()
            return json.loads(raw)

    def start(self, link=None):
        state, verifier, transaction = (secrets.token_urlsafe(32) for _ in range(3))
        with self.lock:
            self.pending = {key: value for key, value in self.pending.items() if value["expires"] > time.time()}
            if len(self.pending) >= 2000:
                raise SsoError("login_capacity_exceeded", 429)
            self.pending[hashed(transaction)] = {"state": state, "verifier": verifier, "expires": time.time() + 600, "link": link}
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
        query = urllib.parse.urlencode({"client_id": self.client_id, "redirect_uri": self.callback,
            "response_type": "code", "scope": "openid profile email urn:zitadel:iam:org:project:id:" + self.project_id + ":aud",
            "state": state, "code_challenge": challenge, "code_challenge_method": "S256"})
        return self.discovery["authorization_endpoint"] + "?" + query, transaction

    def identity(self, access_token):
        profile = self.requester(self.verify_url, headers={"Authorization": "Bearer " + access_token})
        if profile.get("issuer") != self.issuer or not all(isinstance(profile.get(key), str) and profile[key] for key in ["id", "sub", "role"]):
            raise SsoError("identity_mismatch")
        return profile

    def finish(self, parameters, transaction):
        with self.lock:
            pending = self.pending.pop(hashed(transaction or ""), None)
        if not pending or pending["expires"] <= time.time() or parameters.get("state") != pending["state"] or parameters.get("error") or not isinstance(parameters.get("code"), str) or not parameters["code"] or len(parameters["code"]) > 4096:
            raise SsoError("invalid_oauth_callback", 400)
        headers = {"Content-Type": "application/x-www-form-urlencoded"}
        if self.secret:
            encoded = urllib.parse.quote_plus(self.client_id) + ":" + urllib.parse.quote_plus(self.secret)
            headers["Authorization"] = "Basic " + base64.b64encode(encoded.encode()).decode()
        try:
            tokens = self.requester(self.discovery["token_endpoint"], body={"grant_type": "authorization_code",
                "client_id": self.client_id, "redirect_uri": self.callback, "code": parameters["code"], "code_verifier": pending["verifier"]}, headers=headers)
            token, lifetime = tokens.get("access_token"), tokens.get("expires_in")
            if not isinstance(token, str) or not token or not isinstance(lifetime, (float, int)) or isinstance(lifetime, bool) or lifetime <= 0:
                raise SsoError()
            profile = self.identity(token)
            return {"profile": profile, "token": token, "expires": time.time() + min(lifetime, 3600), "checked": time.time(), "link": pending["link"]}
        except SsoError:
            raise
        except Exception:
            raise SsoError() from None

    def remember(self, session_token, identity):
        with self.lock:
            self.sessions = {key: value for key, value in self.sessions.items() if value["expires"] > time.time()}
            self.sessions[hashed(session_token)] = identity

    def verify_session(self, session_token, subject):
        key = hashed(session_token)
        with self.lock:
            identity = self.sessions.get(key)
        if not identity or identity["expires"] <= time.time() or identity["profile"]["sub"] != subject:
            raise SsoError("login_required")
        if time.time() - identity["checked"] > 30:
            try:
                profile = self.identity(identity["token"])
                if profile["sub"] != subject or profile["id"] != identity["profile"]["id"]:
                    raise SsoError()
                identity["profile"], identity["checked"] = profile, time.time()
            except Exception:
                with self.lock:
                    self.sessions.pop(key, None)
                raise SsoError("login_required") from None
        return identity["profile"]

    def forget(self, token):
        with self.lock:
            self.sessions.pop(hashed(token), None)
