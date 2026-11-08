"""OAuth grants are owned by the consenting session, never client-supplied IDs."""
import base64
import hashlib
import http.client
import json
import os
import re
import tempfile
import threading
import unittest
import urllib.parse
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import patch

from server import Store, APIError
from mcp_oauth import McpOAuth
import test_server as gateway

ORIGIN = 'https://euterpe.example'
VERIFIER = 'v' * 43
CHALLENGE = base64.urlsafe_b64encode(hashlib.sha256(VERIFIER.encode()).digest()).decode().rstrip('=')


class OAuthTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = Store(self.directory.name)
        self.oauth = McpOAuth(self.store, APIError)
        self.user = self.store.register({'username': 'alice', 'password': 'long-test-password'})
        self.other = self.store.register({'username': 'bobby', 'password': 'long-test-password'})
        self.client = self.oauth.register({'client_name': 'Test client', 'redirect_uris': ['https://client.example/callback']})
        self.params = {'client_id': self.client['client_id'], 'redirect_uri': 'https://client.example/callback',
                       'response_type': 'code', 'scope': 'read', 'state': 'client-state',
                       'code_challenge': CHALLENGE, 'code_challenge_method': 'S256', 'resource': ORIGIN + '/mcp'}

    def code(self, params=None):
        transaction = self.oauth.begin(params or self.params, ORIGIN)
        self.oauth.bind(transaction, self.user['id'], 'session-proof')
        return self.oauth.consent(transaction, self.user['id'], 'session-proof', True)['code']

    def exchange(self, code, **extra):
        return self.oauth.exchange({'grant_type': 'authorization_code', 'client_id': self.client['client_id'],
            'code': code, 'redirect_uri': self.params['redirect_uri'], 'code_verifier': VERIFIER, **extra}, ORIGIN)

    def refresh(self, token, **extra):
        return self.oauth.exchange({'grant_type': 'refresh_token', 'refresh_token': token,
                                   'client_id': self.client['client_id'], **extra}, ORIGIN)

    def test_code_tokens_and_refresh_persist_and_are_owned_by_consenting_account(self):
        tokens = self.exchange(self.code())
        user, scope = self.store.authenticate_mcp('Bearer ' + tokens['access_token'])
        self.assertEqual((user['id'], scope), (self.user['id'], 'read'))
        self.assertEqual(tokens['expires_in'], 3600)
        self.assertEqual(tokens['token_type'], 'Bearer')
        self.oauth = McpOAuth(Store(self.directory.name), APIError)
        newer = self.refresh(tokens['refresh_token'])
        self.assertNotEqual(newer['refresh_token'], tokens['refresh_token'])
        with self.assertRaises(APIError):
            self.store.authenticate_mcp('Bearer ' + tokens['access_token'])
        self.assertEqual(self.store.authenticate_mcp('Bearer ' + newer['access_token'])[0]['id'], self.user['id'])
        with self.store.db() as c:
            dump = '\n'.join(c.iterdump())
        for secret in (tokens['access_token'], tokens['refresh_token'], newer['refresh_token']):
            self.assertNotIn(secret, dump)

    def test_pkce_redirect_resource_and_client_are_bound_and_code_is_single_use(self):
        code = self.code()
        for changes in ({'code_verifier': 'wrong'}, {'redirect_uri': 'https://attacker.example'},
                        {'client_id': 'different'}, {'resource': 'https://other.example/mcp'}):
            with self.assertRaises(APIError):
                self.exchange(code, **changes)
        tokens = self.exchange(code)
        with self.assertRaises(APIError):
            self.exchange(code)
        with self.assertRaises(APIError):
            self.store.authenticate_mcp('Bearer ' + tokens['access_token'])

    def test_consent_is_bound_to_user_and_session_and_decision_cannot_change(self):
        tx = self.oauth.begin(self.params, ORIGIN)
        self.oauth.bind(tx, self.user['id'], 'session-proof')
        for uid, session in ((self.other['id'], 'session-proof'), (self.user['id'], 'other-session')):
            with self.assertRaises(APIError):
                self.oauth.consent(tx, uid, session, True)
        denied = self.oauth.consent(tx, self.user['id'], 'session-proof', False)
        self.assertEqual(denied['error'], 'access_denied')
        with self.assertRaises(APIError):
            self.oauth.consent(tx, self.user['id'], 'session-proof', True)

    def test_consent_retry_returns_same_unredeemed_code_without_storing_plaintext(self):
        tx = self.oauth.begin(self.params, ORIGIN)
        self.oauth.bind(tx, self.user['id'], 'session-proof')
        first = self.oauth.consent(tx, self.user['id'], 'session-proof', True)
        second = self.oauth.consent(tx, self.user['id'], 'session-proof', True)
        self.assertEqual(first, second)
        with self.store.db() as c:
            self.assertEqual(c.execute('SELECT count(*) FROM oauth_codes').fetchone()[0], 1)
            self.assertNotIn(first['code'], '\n'.join(c.iterdump()))
        tokens = self.exchange(first['code'])
        with self.assertRaises(APIError) as error:
            self.oauth.consent(tx, self.user['id'], 'session-proof', True)
        self.assertEqual(error.exception.code, 'authorization_already_completed')
        self.assertEqual(self.store.authenticate_mcp('Bearer ' + tokens['access_token'])[0]['id'], self.user['id'])
        for uid, session in ((self.other['id'], 'session-proof'), (self.user['id'], 'different-session')):
            with self.assertRaises(APIError):
                self.oauth.consent(tx, uid, session, True)

    def test_revocation_and_refresh_reuse_revoke_family(self):
        tokens = self.exchange(self.code())
        newer = self.refresh(tokens['refresh_token'])
        with self.assertRaises(APIError):
            self.refresh(tokens['refresh_token'])
        with self.assertRaises(APIError):
            self.store.authenticate_mcp('Bearer ' + newer['access_token'])
        with self.assertRaises(APIError):
            self.refresh(newer['refresh_token'])
        tokens = self.exchange(self.code())
        grant = self.store.mcp_tokens(self.user['id'])[0]
        with self.assertRaises(APIError):
            self.store.revoke_mcp_token(self.other['id'], grant['id'])
        self.store.revoke_mcp_token(self.user['id'], grant['id'])
        with self.assertRaises(APIError):
            self.refresh(tokens['refresh_token'])

    def test_expired_transactions_codes_and_refresh_are_rejected(self):
        tx = self.oauth.begin(self.params, ORIGIN)
        with patch('mcp_oauth.time.time', return_value=10**12), self.assertRaises(APIError):
            self.oauth.bind(tx, self.user['id'], 'session-proof')
        code = self.code()
        with patch('mcp_oauth.time.time', return_value=10**12), self.assertRaises(APIError):
            self.exchange(code)
        tokens = self.exchange(self.code())
        with patch('mcp_oauth.time.time', return_value=10**12), self.assertRaises(APIError):
            self.refresh(tokens['refresh_token'])

    def test_registration_and_authorization_fail_closed(self):
        for uri in ('http://external.example/cb', 'https://client.example/cb#fragment',
                    'https://user:pass@client.example/cb', 'javascript:alert(1)', 'https://client.example/cb\r\nX: y',
                    'https://client.example";evil/cb', 'https://client.example\\@attacker.example/cb'):
            with self.assertRaises(APIError):
                self.oauth.register({'redirect_uris': [uri]})
        self.assertEqual(self.oauth.register({'redirect_uris': ['http://127.0.0.1:4500/cb']})['token_endpoint_auth_method'], 'none')
        for changes in ({'code_challenge_method': 'plain'}, {'code_challenge': ''}, {'scope': 'admin'},
                        {'response_type': 'token'}, {'redirect_uri': 'https://client.example/elsewhere'}):
            with self.assertRaises(APIError):
                self.oauth.begin({**self.params, **changes}, ORIGIN)

    def test_refresh_equivalent_scopes_do_not_escalate_read_grants(self):
        tokens = self.exchange(self.code({**self.params, 'scope': 'read write'}))
        self.assertEqual(tokens['scope'], 'read write')
        refreshed = self.refresh(tokens['refresh_token'], scope='write read')
        self.assertEqual(refreshed['scope'], 'read write')
        reader = self.exchange(self.code())
        with self.assertRaises(APIError):
            self.refresh(reader['refresh_token'], scope='read write')
        self.assertEqual(self.refresh(reader['refresh_token'], scope='read')['scope'], 'read')

    def test_concurrent_code_redemption_issues_only_one_grant(self):
        code = self.code()
        def redeem(_):
            try:
                return self.exchange(code)
            except APIError:
                return None
        with ThreadPoolExecutor(max_workers=2) as pool:
            replies = list(pool.map(redeem, range(2)))
        self.assertEqual(sum(reply is not None for reply in replies), 1)


class OAuthHTTPTests(unittest.TestCase):
    setUpClass = classmethod(gateway.GatewayTests.setUpClass.__func__)
    tearDownClass = classmethod(gateway.GatewayTests.tearDownClass.__func__)
    account = gateway.GatewayTests.account

    def setUp(self):
        self.server.app.login_attempts.clear()
        self.env = patch.dict(os.environ, {'WEB_PUBLIC_ORIGIN': ORIGIN})
        self.env.start()
        self.addCleanup(self.env.stop)

    def request(self, path, method='GET', body=None, auth=None, headers=None):
        client = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        supplied = {'Content-Type': 'application/json', **(headers or {})}
        if auth:
            supplied.update({'Cookie': auth[0], 'X-CSRF-Token': auth[1]})
        payload = json.dumps(body) if isinstance(body, dict) else body
        client.request(method, path, payload, supplied)
        response = client.getresponse()
        raw = response.read()
        result = json.loads(raw) if response.getheader('Content-Type', '').startswith('application/json') else raw
        data = (response.status, result, dict(response.getheaders()))
        client.close()
        return data

    def form(self, path, data, auth=None):
        return self.request(path, 'POST', urllib.parse.urlencode(data), auth,
                            {'Content-Type': 'application/x-www-form-urlencoded'})

    def registration(self, **extra):
        status, client, _ = self.request('/oauth/register', 'POST', {
            'client_name': 'HTTP client <script>alert(1)</script>',
            'redirect_uris': ['https://client.example/callback'], **extra})
        self.assertEqual(status, 201)
        return client

    def authorize(self, client, auth, **extra):
        params = {'client_id': client['client_id'], 'redirect_uri': client['redirect_uris'][0],
            'response_type': 'code', 'code_challenge': CHALLENGE, 'code_challenge_method': 'S256',
            'resource': ORIGIN + '/mcp', 'state': 'abc', **extra}
        return self.request('/oauth/authorize?' + urllib.parse.urlencode(params), auth=auth)

    def approve(self, client, auth):
        status, html, _ = self.authorize(client, auth)
        self.assertEqual(status, 200)
        self.assertNotIn(b'<script>alert', html)
        fields = dict(re.findall(r'name="(transaction|csrf)" value="([^"]+)"', html.decode()))
        status, _, response = self.form('/oauth/authorize', {**fields, 'decision': 'approve'}, auth)
        self.assertEqual(status, 303)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(response['Location']).query)
        self.assertEqual(query['state'], ['abc'])
        return query['code'][0]

    def token(self, client, code):
        return self.form('/oauth/token', {'client_id': client['client_id'], 'code': code,
            'redirect_uri': client['redirect_uris'][0], 'code_verifier': VERIFIER, 'grant_type': 'authorization_code'})

    def test_discovery_and_challenge_do_not_start_compute(self):
        before = len(self.workers.items)
        status, resource, _ = self.request('/.well-known/oauth-protected-resource/mcp')
        self.assertEqual(status, 200)
        self.assertEqual(resource['resource'], ORIGIN + '/mcp')
        self.assertEqual(resource['authorization_servers'], [ORIGIN])
        self.assertEqual(self.request('/.well-known/oauth-protected-resource')[1], resource)
        metadata = self.request('/.well-known/oauth-authorization-server')[1]
        self.assertEqual(metadata['code_challenge_methods_supported'], ['S256'])
        self.assertEqual(metadata['registration_endpoint'], ORIGIN + '/oauth/register')
        status, _, headers = self.request('/mcp')
        self.assertEqual(status, 401)
        self.assertIn('resource_metadata="' + ORIGIN, headers['WWW-Authenticate'])
        self.assertEqual(len(self.workers.items), before)

    def test_http_consent_is_csrf_and_account_bound_and_grant_can_be_revoked(self):
        auth, user = self.account()
        other, _ = self.account()
        client = self.registration()
        status, html, _ = self.authorize(client, auth)
        self.assertEqual(status, 200)
        fields = dict(re.findall(r'name="(transaction|csrf)" value="([^"]+)"', html.decode()))
        self.assertEqual(self.form('/oauth/authorize', {**fields, 'csrf': 'wrong', 'decision': 'approve'},
                                   (auth[0], 'wrong'))[0], 403)
        self.assertEqual(self.form('/oauth/authorize', {**fields, 'csrf': other[1], 'decision': 'approve'}, other)[0], 400)
        status, _, response = self.form('/oauth/authorize', {**fields, 'decision': 'approve'}, auth)
        self.assertEqual(status, 303)
        code = urllib.parse.parse_qs(urllib.parse.urlsplit(response['Location']).query)['code'][0]
        status, tokens, _ = self.token(client, code)
        self.assertEqual(status, 200)
        raw = tokens['access_token']
        self.assertEqual(self.server.app.store.authenticate_mcp('Bearer ' + raw)[0]['id'], user['id'])
        self.assertEqual(self.request('/api/mcp/tokens', auth=other)[1]['tokens'], [])
        self.assertEqual(self.form('/oauth/revoke', {'client_id': client['client_id'], 'token': raw})[0], 200)
        self.assertEqual(self.request('/mcp', headers={'Authorization': 'Bearer ' + raw})[0], 401)
        self.assertEqual(self.form('/oauth/token', {'client_id': client['client_id'],
            'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']})[:2], (400, {'error': 'invalid_grant'}))

    def test_form_exchange_duplicate_parameters_and_foreign_origin_fail_closed(self):
        auth, _ = self.account()
        client = self.registration()
        code = self.approve(client, auth)
        self.assertEqual(self.request('/oauth/token', 'POST', 'client_id=a&client_id=b',
            headers={'Content-Type': 'application/x-www-form-urlencoded'})[0], 400)
        self.assertEqual(self.request('/oauth/register', 'POST', {}, headers={'Origin': 'https://attacker.example'})[0], 403)
        status, tokens, _ = self.token(client, code)
        self.assertEqual(status, 200)
        self.assertEqual(tokens['scope'], 'read')
        self.assertEqual(self.request('/oauth/authorize?client_id=a&client_id=b')[0], 400)

    def test_combined_write_scope_is_explicit_on_consent(self):
        auth, _ = self.account()
        client = self.registration()
        status, html, _ = self.authorize(client, auth, scope='read write')
        self.assertEqual(status, 200)
        self.assertIn('alterar playlists'.encode(), html)
        self.assertIn('automaticamente'.encode(), html)
        self.assertNotIn('Sem permissão para alterar'.encode(), html)

    def test_duplicate_consent_post_preserves_callback_and_expired_browser_request_is_readable(self):
        auth, _ = self.account()
        client = self.registration()
        status, html, _ = self.authorize(client, auth)
        self.assertEqual(status, 200)
        fields = dict(re.findall(r'name="(transaction|csrf)" value="([^"]+)"', html.decode()))
        first = self.form('/oauth/authorize', {**fields, 'decision': 'approve'}, auth)
        second = self.form('/oauth/authorize', {**fields, 'decision': 'approve'}, auth)
        self.assertEqual(first[0], 303)
        self.assertEqual((second[0], second[2].get('Location')), (303, first[2]['Location']))
        status, page, headers = self.request('/oauth/authorize?transaction=expired', auth=auth,
            headers={'Accept': 'text/html'})
        self.assertEqual(status, 400)
        self.assertTrue(headers['Content-Type'].startswith('text/html'))
        self.assertIn('inicie a conexão novamente'.encode(), page)

    def test_successful_refreshes_are_not_globally_throttled_by_proxy_ip(self):
        auth, _ = self.account()
        client = self.registration()
        tokens = self.token(client, self.approve(client, auth))[1]
        for _ in range(25):
            status, tokens, _ = self.form('/oauth/token', {'client_id': client['client_id'],
                'grant_type': 'refresh_token', 'refresh_token': tokens['refresh_token']})
            self.assertEqual(status, 200)

    def test_sso_callback_returns_to_only_the_stored_mcp_transaction(self):
        from rda_sso import RdaSso
        from test_rda_sso import PROFILE, ISSUER
        def requester(url, body=None, headers=None):
            if url.endswith('openid-configuration'):
                return {'issuer': ISSUER, 'authorization_endpoint': ISSUER + '/authorize', 'token_endpoint': ISSUER + '/token'}
            if url.endswith('/token'):
                return {'access_token': 'synthetic-token', 'expires_in': 300}
            return PROFILE
        sso = RdaSso(ORIGIN, 'client', 'project', requester=requester)
        client = self.registration()
        with patch.object(self.server.app, 'sso', sso):
            status, _, headers = self.authorize(client, None)
            self.assertEqual(status, 303)
            query = urllib.parse.parse_qs(urllib.parse.urlsplit(headers['Location']).query)
            state_cookie = headers['Set-Cookie'].split(';')[0]
            status, _, callback = self.request('/api/account/sso/callback?' + urllib.parse.urlencode({
                'state': query['state'][0], 'code': 'synthetic-code'}), headers={'Cookie': state_cookie})
            self.assertEqual(status, 303)
            self.assertTrue(callback['Location'].startswith('/oauth/authorize?transaction='))
            # HTTP header dictionary retains the last cookie; the session is the last Set-Cookie.
            cookie = callback['Set-Cookie'].split(';')[0]
            status, html, _ = self.request(callback['Location'], headers={'Cookie': cookie})
            self.assertEqual(status, 200)
            self.assertIn(b'Autorizar', html)

    def test_initialize_wakes_only_valid_requests_and_reports_compute_failure(self):
        auth, _ = self.account()
        client = self.registration()
        tokens = self.token(client, self.approve(client, auth))[1]
        headers = {'Authorization': 'Bearer ' + tokens['access_token'], 'Accept': 'application/json, text/event-stream'}
        body = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-11-25', 'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}}}
        with patch.object(self.workers, 'lease', wraps=self.workers.lease) as lease:
            self.assertEqual(self.request('/mcp', 'POST', body)[0], 401)
            self.assertEqual(self.request('/mcp', 'POST', {**body, 'jsonrpc': 'wrong'}, headers=headers)[1]['error']['code'], -32600)
            self.assertEqual(self.request('/mcp', 'POST', body, headers={**headers, 'MCP-Protocol-Version': 'invalid'})[0], 400)
            for params in ({}, {'protocolVersion': '2025-11-25'}, {**body['params'], 'capabilities': []}):
                self.assertEqual(self.request('/mcp', 'POST', {**body, 'params': params}, headers=headers)[1]['error']['code'], -32602)
            self.assertEqual(lease.call_count, 0)
            status, result, _ = self.request('/mcp', 'POST', body, headers=headers)
            self.assertEqual(status, 200)
            self.assertEqual(lease.call_count, 1)
            self.assertEqual(result['result']['protocolVersion'], '2025-11-25')
        with patch.object(self.workers, 'lease', side_effect=APIError('compute_unavailable', 503)):
            self.assertEqual(self.request('/mcp', 'POST', body, headers=headers)[:2], (503, {'error': 'compute_unavailable'}))

    def test_no_ui_cookie_resume_and_spoofed_owner_never_selects_another_compute(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        from pathlib import Path
        from server import PlatformWorkers, digest
        calls, running, starts = [], set(), []
        class RuntimeHandler(BaseHTTPRequestHandler):
            def log_message(self, *_): pass
            def do_POST(self):
                owner = json.loads(base64.urlsafe_b64decode(self.headers['X-RDA-Runtime-Owner'] + '==='))['id']
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append((owner, self.path, dict(self.headers), body))
                if self.path.endswith('/instance'):
                    if owner not in running:
                        starts.append(owner)
                    running.add(owner)
                    result = {'state': 'running'}
                else:
                    result = {'jsonrpc': '2.0', 'id': body['id'], 'result': {'owner': owner}}
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(result).encode())
        runtime = ThreadingHTTPServer(('127.0.0.1', 0), RuntimeHandler)
        thread = threading.Thread(target=runtime.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                key = Path(directory) / 'runtime.key'
                key.write_text('synthetic-runtime-secret-' * 2)
                users = [self.account()[1] for _ in range(2)]
                store, oauth = self.server.app.store, self.server.app.oauth
                credentials = []
                client = self.registration()
                for user in users:
                    session = store.issue_session(user['id'])
                    store.bind_sso({'issuer': 'https://synthetic.invalid', 'sub': user['id'], 'id': 'canonical-' + user['id']}, user['id'], digest(session))
                    tx = oauth.begin({'client_id': client['client_id'], 'redirect_uri': client['redirect_uris'][0],
                        'response_type': 'code', 'code_challenge': CHALLENGE, 'code_challenge_method': 'S256'}, ORIGIN)
                    oauth.bind(tx, user['id'], session)
                    code = oauth.consent(tx, user['id'], session, True)['code']
                    credentials.append(self.token(client, code)[1]['access_token'])
                with patch.dict(os.environ, {'RDA_RUNTIME_URL': f'http://127.0.0.1:{runtime.server_port}', 'RDA_RUNTIME_KEY_FILE': str(key)}):
                    workers = PlatformWorkers(store)
                with patch.object(self.server.app, 'workers', workers):
                    for index, token in enumerate(credentials):
                        headers = {'Authorization': 'Bearer ' + token, 'Accept': 'application/json, text/event-stream',
                            'X-RDA-Runtime-Owner': 'forged-owner', 'X-RDA-Runtime-Key': 'forged-key'}
                        body = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18',
                            'capabilities': {}, 'clientInfo': {'name': 'test', 'version': '1'}, 'user_id': users[1-index]['id']}}
                        self.assertEqual(self.request('/mcp', 'POST', body, headers=headers)[0], 200)
                        self.assertEqual(starts[-1], 'canonical-' + users[index]['id'])
                        running.clear()  # Simulate suspension after the client closed its browser.
                        body.update(method='tools/call', params={'name': 'spotify_get_playlists', 'arguments': {}, 'user_id': users[1-index]['id']})
                        reply = self.request('/mcp', 'POST', body, headers=headers)[1]
                        self.assertEqual(reply['result']['owner'], 'canonical-' + users[index]['id'])
                    self.assertEqual(len(starts), 4)
                    for owner, path, headers, payload in calls:
                        self.assertEqual(headers['X-Rda-Runtime-Key'], key.read_text())
                        self.assertNotIn('Cookie', headers)
                        self.assertNotIn('Authorization', headers)
                        if path.endswith('/instance'):
                            expected = store.user(owner.removeprefix('canonical-'))
                            self.assertEqual(payload['inputs']['DAEMON_KEY'], expected['daemon_key'])
        finally:
            runtime.shutdown()
            runtime.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
