"""Unit & Contract tests for Euterpe curation engine, workflow DAGs, and RDA AI integration."""
from contextlib import contextmanager
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import uuid

from curation import (
    COORDENADAS_DIEGETICAS,
    DRAMATURGIAS,
    EDITORIAL_MODELS,
    EIXOS_CURATORIAIS,
    compute_approval_hash,
    validate_dag,
)
from rda_ai_client import RdaAiClient, issue_delegation_grant, issue_workload_token
from server import COOKIE, make_server


class FakeWorker:
    def __init__(self):
        self.pending = []

    def tool(self, name, args):
        if name in {"get_saved_tracks", "search_spotify", "get_playlists"}:
            return True, {"tracks": [{"id": "t1", "name": "Faixa Teste", "artists": [{"name": "Artista A"}]}]}
        return True, {"ok": True}

    def json(self, path, method="GET", body=None):
        return 200, {}


class FakeWorkers:
    @contextmanager
    def lease(self, user):
        yield FakeWorker()

    def close(self):
        pass


class CurationWorkflowTests(unittest.TestCase):
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
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        cls.directory.cleanup()

    def request(self, path, method="GET", body=None, auth=None):
        client = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = {"Content-Type": "application/json"}
        if auth:
            headers.update(Cookie=auth[0], **{"X-CSRF-Token": auth[1]})
        client.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = client.getresponse()
        raw = response.read()
        res = json.loads(raw) if response.getheader("Content-Type", "").startswith("application/json") else raw
        resp_headers = dict(response.getheaders())
        client.close()
        return response.status, res, resp_headers

    def register_account(self):
        username = "curator" + uuid.uuid4().hex[:10]
        status, res, headers = self.request(
            "/api/account/register",
            "POST",
            {"username": username, "password": "Password1234!Long", "display_name": "Curador Teste"},
        )
        self.assertEqual(status, 200)
        cookie = headers["Set-Cookie"].split(";")[0]
        return cookie, res["csrf"], res["user"]["id"]

    def test_dag_validation_acyclic_and_cycles(self):
        # 1. Valid linear DAG
        steps = [
            {"id": "step_a"},
            {"id": "step_b"},
            {"id": "step_c"},
        ]
        edges = [
            {"source": "step_a", "target": "step_b"},
            {"source": "step_b", "target": "step_c"},
        ]
        valid, order, err = validate_dag(steps, edges)
        self.assertTrue(valid)
        self.assertEqual(order, ["step_a", "step_b", "step_c"])
        self.assertIsNone(err)

        # 2. Cycle detection (A -> B -> A)
        edges_cyclic = [
            {"source": "step_a", "target": "step_b"},
            {"source": "step_b", "target": "step_a"},
        ]
        valid, order, err = validate_dag(steps, edges_cyclic)
        self.assertFalse(valid)
        self.assertIn("Ciclo de dependência detectado", err)

        # 3. Self loop
        edges_self = [{"source": "step_a", "target": "step_a"}]
        valid, order, err = validate_dag(steps, edges_self)
        self.assertFalse(valid)
        self.assertIn("Ciclo detectado", err)

    def test_approval_hash_determinism(self):
        p1 = {"name": "Playlist A", "tracks": ["spotify:track:1", "spotify:track:2"]}
        p2 = {"tracks": ["spotify:track:1", "spotify:track:2"], "name": "Playlist A"}
        h1 = compute_approval_hash("user_123", "euterpe", "publish_curation", p1)
        h2 = compute_approval_hash("user_123", "euterpe", "publish_curation", p2)
        self.assertEqual(h1, h2, "Payload hash must be canonically sorted and identical")

    def test_rda_ai_tokens(self):
        token = issue_workload_token()
        self.assertIn(".", token)
        grant = issue_delegation_grant(user_id="user_test", run_id="run_test")
        self.assertIn(".", grant)

    def test_curation_endpoints_and_workflow_execution(self):
        cookie, csrf, user_id = self.register_account()
        auth = (cookie, csrf)

        # 1. Editorial models catalog
        status, models_data, _ = self.request("/api/editorial-models", "GET", auth=auth)
        self.assertEqual(status, 200)
        self.assertTrue(len(models_data["models"]) >= 4)
        self.assertEqual(len(models_data["dramaturgias"]), 12)
        self.assertEqual(len(models_data["coordenadas"]), 10)
        self.assertEqual(len(models_data["eixos"]), 10)

        # 2. AI models
        status, ai_data, _ = self.request("/api/ai/models", "GET", auth=auth)
        self.assertEqual(status, 200)
        aliases = [m["alias"] for m in ai_data["models"]]
        self.assertIn("rda/chat-default", aliases)

        # 3. Create curation project with Escuta & Imagem model
        create_payload = {
            "title": "Cosmos Noturno",
            "editorial_model": "escuta-e-imagem-v2",
            "dramaturgia": "transe_espiral",
            "briefing": {
                "territorio": "Sertão cósmico",
                "luz": "Breu total com estrelas",
                "somatismo": "Transe hipnótico lento",
            },
        }
        status, created, _ = self.request("/api/curations", "POST", create_payload, auth=auth)
        self.assertEqual(status, 201)
        cur_id = created["id"]
        self.assertEqual(created["title"], "Cosmos Noturno")
        self.assertEqual(created["dramaturgia"], "transe_espiral")
        self.assertIsNotNone(created["workflow"])

        # 4. List curations
        status, cur_list, _ = self.request("/api/curations", "GET", auth=auth)
        self.assertEqual(status, 200)
        self.assertEqual(len(cur_list["curations"]), 1)

        # 5. Get single curation
        status, item, _ = self.request(f"/api/curations/{cur_id}", "GET", auth=auth)
        self.assertEqual(status, 200)
        self.assertEqual(item["id"], cur_id)
        self.assertEqual(item["briefing"]["territorio"], "Sertão cósmico")

        # 6. Save valid workflow
        wf = item["workflow"]
        wf["steps"][0]["instructions"] = "Foco em texturas analógicas"
        status, wf_save, _ = self.request(f"/api/curations/{cur_id}/workflow", "PUT", wf, auth=auth)
        self.assertEqual(status, 200)
        self.assertTrue(wf_save["ok"])
        self.assertEqual(wf_save["version"], 2)

        # 7. Reject cyclic workflow
        cyclic_wf = json.loads(json.dumps(wf))
        cyclic_wf["edges"].append({"source": cyclic_wf["steps"][-1]["id"], "target": cyclic_wf["steps"][0]["id"]})
        status, cyc_res, _ = self.request(f"/api/curations/{cur_id}/workflow", "PUT", cyclic_wf, auth=auth)
        self.assertEqual(status, 422)

        # 8. Execute curation workflow -> demonstrates pause at approval gate (Decision 17A)
        status, exec_res, _ = self.request(f"/api/curations/{cur_id}/execute", "POST", {}, auth=auth)
        self.assertEqual(status, 200)
        self.assertEqual(exec_res["status"], "awaiting_approval")
        self.assertIsNotNone(exec_res["pending_approval"])
        self.assertEqual(exec_res["pending_approval"]["action_type"], "publish_curation")

        # 9. Get curatorial dossier
        status, dossier, _ = self.request(f"/api/curations/{cur_id}/dossier", "GET", auth=auth)
        self.assertEqual(status, 200)
        self.assertIn("# Dossiê Curatorial — Cosmos Noturno", dossier["markdown"])
        self.assertIn("Transe Gravitacional / Espiral", dossier["markdown"])
        self.assertIn("Sertão cósmico", dossier["markdown"])

        # 10. Delete project
        status, del_res, _ = self.request(f"/api/curations/{cur_id}", "DELETE", auth=auth)
        self.assertEqual(status, 200)
        self.assertTrue(del_res["ok"])


if __name__ == "__main__":
    unittest.main()
