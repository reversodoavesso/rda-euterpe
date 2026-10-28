"""RDA AI Gateway and Agent Runtime client for Euterpe.

Implements M2M workload token signing (sa:euterpe-backend) and user delegation grant
signing (app_id=euterpe), adhering to Decision 13C, 14A, 18B, and 20A.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import time
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _b64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode((value + padding).encode("ascii"))


def sign_compact_jwt(payload: Dict[str, Any], secret: bytes) -> str:
    header = {"alg": "HS256", "typ": "JWT"}
    h_b64 = _b64url_encode(json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    p_b64 = _b64url_encode(json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8"))
    signing_input = f"{h_b64}.{p_b64}".encode("ascii")
    sig = hmac.new(secret, signing_input, hashlib.sha256).digest()
    return f"{h_b64}.{p_b64}.{_b64url_encode(sig)}"


def issue_workload_token(
    scopes: Optional[List[str]] = None,
    ttl_seconds: int = 3600,
    secret_bytes: Optional[bytes] = None,
) -> str:
    scopes_list = scopes or ["ai:inference:use", "ai:model:read", "ai:usage:read"]
    raw_secret = os.getenv("RDA_AI_M2M_SECRET", "rda-ai-m2m-default-secret-32bytes!")
    secret = secret_bytes or raw_secret.encode("utf-8")[:32]
    now = int(time.time())
    payload = {
        "iss": os.getenv("RDA_AI_ISSUER", "https://id.reversodoavesso.com"),
        "sub": "sa:euterpe-backend",
        "client_id": "euterpe-backend",
        "aud": "rda-ai-gateway",
        "scope": " ".join(sorted(scopes_list)),
        "iat": now,
        "exp": now + ttl_seconds,
    }
    return sign_compact_jwt(payload, secret)


def issue_delegation_grant(
    user_id: str,
    run_id: str,
    role: str = "initiate",
    tier: int = 2,
    scopes: Optional[List[str]] = None,
    ttl_seconds: int = 900,
    secret_bytes: Optional[bytes] = None,
) -> str:
    scopes_list = scopes or ["ai:inference:use", "ai:model:read", "ai:usage:read"]
    raw_secret = os.getenv("RDA_AI_DELEGATION_SECRET", "rda-ai-delegation-secret-32bytes!!")
    secret = secret_bytes or raw_secret.encode("utf-8")[:32]
    now = int(time.time())
    payload = {
        "iss": "rda:app:euterpe",
        "sub": str(user_id),
        "app_id": "euterpe",
        "run_id": str(run_id),
        "role": role,
        "tier": tier,
        "scope": " ".join(sorted(scopes_list)),
        "iat": now,
        "exp": now + ttl_seconds,
    }
    return sign_compact_jwt(payload, secret)


class RdaAiClient:
    def __init__(
        self,
        gateway_url: Optional[str] = None,
        runtime_url: Optional[str] = None,
        m2m_secret: Optional[bytes] = None,
        delegation_secret: Optional[bytes] = None,
    ) -> None:
        self.gateway_url = (gateway_url or os.getenv("RDA_AI_GATEWAY_URL", "http://127.0.0.1:4010")).rstrip("/")
        self.runtime_url = (runtime_url or os.getenv("RDA_AI_RUNTIME_URL", "http://127.0.0.1:4011")).rstrip("/")
        self.m2m_secret = m2m_secret
        self.delegation_secret = delegation_secret

    def get_auth_headers(self, user_id: Optional[str] = None, run_id: Optional[str] = None) -> Dict[str, str]:
        token = issue_workload_token(secret_bytes=self.m2m_secret)
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        if user_id and run_id:
            grant = issue_delegation_grant(user_id=user_id, run_id=run_id, secret_bytes=self.delegation_secret)
            headers["X-RDA-Delegation"] = grant
        return headers

    def list_models(self) -> List[Dict[str, Any]]:
        url = f"{self.gateway_url}/v1/models"
        headers = self.get_auth_headers()
        req = urllib.request.Request(url, headers=headers, method="GET")
        try:
            with OPENER.open(req, timeout=5) as res:
                body = json.loads(res.read().decode("utf-8"))
                return body.get("data", [])
        except Exception:
            # Fallback to canonical RDA AI aliases if gateway is unreachable in dev
            return [
                {"id": "rda/chat-default", "alias": "rda/chat-default", "role_functions": ["chat", "synthesis"]},
                {"id": "rda/fast", "alias": "rda/fast", "role_functions": ["research", "selection"]},
                {"id": "rda/reasoning", "alias": "rda/reasoning", "role_functions": ["briefing", "sequencing", "review"]},
                {"id": "rda/vision", "alias": "rda/vision", "role_functions": ["vision", "image_edit"]},
            ]

    def validate_workflow(self, workflow_dict: Dict[str, Any], user_id: str) -> Dict[str, Any]:
        url = f"{self.runtime_url}/v1/workflows/validate"
        run_id = f"val_{int(time.time())}"
        headers = self.get_auth_headers(user_id=user_id, run_id=run_id)
        data = json.dumps(workflow_dict, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        try:
            with OPENER.open(req, timeout=8) as res:
                return json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            raw = err.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw)
            except Exception:
                parsed = {"error": raw, "code": "http_error"}
            return {"valid": False, "status": err.code, "error": parsed}
        except Exception as exc:
            return {"valid": False, "error": str(exc), "code": "network_error"}

    def create_run(
        self,
        workflow_dict: Dict[str, Any],
        user_id: str,
        run_id: str,
        conversation_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{self.runtime_url}/v1/runs"
        headers = self.get_auth_headers(user_id=user_id, run_id=run_id)
        payload = {
            "run_id": run_id,
            "conversation_id": conversation_id,
            "workflow": workflow_dict,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with OPENER.open(req, timeout=10) as res:
            return json.loads(res.read().decode("utf-8"))

    def resume_run(
        self,
        run_id: str,
        approval_id: str,
        approved: bool,
        payload_hash: str,
        user_id: str,
    ) -> Dict[str, Any]:
        url = f"{self.runtime_url}/v1/runs/{run_id}/resume"
        headers = self.get_auth_headers(user_id=user_id, run_id=run_id)
        payload = {
            "approval_id": approval_id,
            "approved": approved,
            "payload_hash": payload_hash,
        }
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        with OPENER.open(req, timeout=10) as res:
            return json.loads(res.read().decode("utf-8"))
