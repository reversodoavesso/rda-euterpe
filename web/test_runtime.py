"""Application delegation contract; no Spotify credentials or real SSO accounts."""
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
import time
from unittest.mock import patch
from server import PlatformWorkers, Store, APIError


class RuntimeTest(unittest.TestCase):
    def test_legacy_fallback_uses_one_supervisor_for_concurrent_requests(self):
        calls = []
        class Manager:
            def __init__(self, store):
                calls.append(store)
                time.sleep(0.03)
            @contextmanager
            def lease(self, user): yield self
        class LocalStore:
            def sso_binding(self, _): return None
        with tempfile.TemporaryDirectory() as directory:
            key = Path(directory) / 'runtime.key'
            key.write_text('synthetic-application-key-' * 2)
            with patch.dict(os.environ, {'RDA_RUNTIME_URL': 'http://127.0.0.1:3008', 'RDA_RUNTIME_KEY_FILE': str(key), 'RDA_RUNTIME_LEGACY_FALLBACK': 'true'}), patch('server.Workers', Manager):
                workers = PlatformWorkers(LocalStore())
                def lease(_):
                    with workers.lease({'id': 'local'}) as worker: return worker
                with ThreadPoolExecutor(max_workers=2) as pool:
                    leases = list(pool.map(lease, [1, 2]))
                self.assertIs(leases[0], leases[1])
                self.assertEqual(len(calls), 1)

    def test_gateway_delegates_separate_owners_and_requires_explicit_rda_binding(self):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((dict(self.headers), body))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"state":"running"}')
        http = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=http.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                key = Path(directory) / 'runtime.key'
                key.write_text('synthetic-application-key-' * 2)
                store = Store(Path(directory) / 'accounts')
                users = [store.register({'username': name, 'password': 'synthetic-password-123'}) for name in ['alice', 'bob']]
                with patch.dict(os.environ, {'RDA_RUNTIME_URL': f'http://127.0.0.1:{http.server_port}', 'RDA_RUNTIME_KEY_FILE': str(key)}):
                    workers = PlatformWorkers(store)
                    with self.assertRaises(APIError) as error:
                        with workers.lease(users[0]): pass
                    self.assertEqual(error.exception.code, 'link_rda_before_compute_migration')
                    for user in users:
                        token = store.issue_session(user['id'])
                        from server import digest
                        store.bind_sso({'issuer': 'https://synthetic.invalid', 'sub': user['username'], 'id': 'canonical-' + user['username']}, user['id'], digest(token))
                        with workers.lease(user) as worker:
                            self.assertEqual(worker.user['id'], user['id'])
                    identities = [json.loads(base64.urlsafe_b64decode(h['X-Rda-Runtime-Owner'] + '===')) for h, _ in calls]
                    self.assertNotEqual(identities[0]['id'], identities[1]['id'])
                    self.assertEqual(calls[0][1]['inputs']['DAEMON_KEY'], users[0]['daemon_key'])
        finally:
            http.shutdown()
            http.server_close()


if __name__ == '__main__': unittest.main()
