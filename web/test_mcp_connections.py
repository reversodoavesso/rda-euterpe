"""Owner-visible connection states must follow grants, not token lifetimes."""
import json
import time
import unittest
from unittest.mock import patch
import test_mcp_oauth as oauth_tests
from server import APIError
from mcp_oauth import McpOAuth, hashed


class ConnectionsTests(unittest.TestCase):
    setUp = oauth_tests.OAuthTests.setUp
    code = oauth_tests.OAuthTests.code
    exchange = oauth_tests.OAuthTests.exchange
    refresh = oauth_tests.OAuthTests.refresh

    def test_connection_state_owner_scope_refresh_and_legacy_revocation(self):
        tokens = self.exchange(self.code())
        listing = self.oauth.connections(self.user['id'])
        connection = listing['connections'][0]
        self.assertEqual(connection['status'], 'authorized')
        self.assertEqual(connection['name'], 'Test client')
        self.assertEqual(self.oauth.connections(self.other['id'])['connections'], [])
        with self.assertRaises(APIError):
            self.oauth.revoke_connection(self.other['id'], connection['id'])
        self.store.authenticate_mcp('Bearer ' + tokens['access_token'])
        self.assertEqual(self.oauth.connections(self.user['id'])['connections'][0]['status'], 'authorized')
        self.oauth.record_use('Bearer ' + tokens['access_token'])
        self.assertEqual(self.oauth.connections(self.user['id'])['connections'][0]['status'], 'used')
        with self.store.db() as c:
            c.execute('UPDATE mcp_tokens SET expires=? WHERE user_id=?', (time.time() - 1, self.user['id']))
        connection = self.oauth.connections(self.user['id'])['connections'][0]
        self.assertEqual(connection['status'], 'renewable')
        renewed = self.refresh(tokens['refresh_token'])
        self.assertEqual(self.oauth.connections(self.user['id'])['connections'][0]['id'], connection['id'])
        token_id = self.store.mcp_tokens(self.user['id'])[0]['id']
        self.store.revoke_mcp_token(self.user['id'], token_id)
        self.assertEqual(self.oauth.connections(self.user['id'])['connections'][0]['status'], 'revoked')
        with self.assertRaises(APIError):
            self.refresh(renewed['refresh_token'])

    def test_attempt_stages_are_private_safe_bounded_and_expire(self):
        tx = self.oauth.begin(self.params, 'https://euterpe.example')
        self.assertEqual(self.oauth.connections(self.other['id'])['attempts'], [])
        self.oauth.bind(tx, self.user['id'], 'session-proof')
        self.assertEqual(self.oauth.connections(self.user['id'])['attempts'][0]['status'], 'awaiting_consent')
        self.oauth.consent(tx, self.user['id'], 'session-proof', True)
        self.assertEqual(self.oauth.connections(self.user['id'])['attempts'][0]['status'], 'awaiting_client')
        code = self.oauth.continuation(tx, self.user['id'], 'session-proof')['code']
        self.exchange(code)
        report = json.dumps(self.oauth.connections(self.user['id']))
        for secret in (tx, code, 'session-proof', self.params['code_challenge']):
            self.assertNotIn(secret, report)
        self.assertEqual(self.oauth.connections(self.user['id'])['attempts'][0]['status'], 'connected')
        with self.store.db() as c:
            for i in range(205):
                McpOAuth.event(c, self.user['id'], {'_attempt_id': str(i), 'client_name': 'Test', 'scope': 'read', 'redirect_uri': 'https://client.example/cb'}, 'bound')
            self.assertLessEqual(c.execute('SELECT count(*) FROM oauth_events WHERE user_id=?', (self.user['id'],)).fetchone()[0], 200)
        with patch('mcp_oauth.time.time', return_value=time.time() + 8 * 86400):
            self.assertEqual(self.oauth.connections(self.user['id'])['attempts'], [])

    def test_quota_counts_renewable_oauth_grants_and_personal_tokens(self):
        tokens = self.exchange(self.code())
        with self.store.db() as c:
            c.execute('UPDATE mcp_tokens SET expires=1 WHERE user_id=?', (self.user['id'],))
        for i in range(19):
            self.store.issue_mcp_token(self.user['id'], {'name': str(i)})
        with self.assertRaises(APIError) as error:
            self.store.issue_mcp_token(self.user['id'], {'name': 'over quota'})
        self.assertEqual(error.exception.code, 'token_limit')
        with self.assertRaises(APIError):
            self.exchange(self.code())
        self.assertIn('access_token', self.refresh(tokens['refresh_token']))

    def test_migration_is_idempotent_and_keeps_existing_credentials(self):
        tokens = self.exchange(self.code())
        with self.store.db() as c:
            # A rollback to the previous image still inserts exactly 8 values.
            self.assertEqual(len(c.execute('PRAGMA table_info(oauth_grants)').fetchall()), 8)
            c.execute('DELETE FROM oauth_grant_details')
            c.execute('INSERT INTO oauth_grants VALUES (?,?,?,?,?,?,?,0)',
                      ('legacy-shape', self.client['client_id'], self.user['id'], 'read',
                       'https://euterpe.example/mcp', 'no-token', time.time() + 3600))
            c.execute('DELETE FROM oauth_grants WHERE id=?', ('legacy-shape',))
        again = McpOAuth(self.store, APIError)
        self.store.authenticate_mcp('Bearer ' + tokens['access_token'])
        self.assertIsNone(again.connections(self.user['id'])['connections'][0]['created'])
        self.assertEqual(again.connections(self.user['id'])['connections'][0]['name'], 'Test client')
        again.revoke_connection(self.user['id'], again.connections(self.user['id'])['connections'][0]['id'])
        with self.assertRaises(APIError):
            self.store.authenticate_mcp('Bearer ' + tokens['access_token'])

    def test_grant_expiry_rejects_access_even_if_access_token_has_time_left(self):
        tokens = self.exchange(self.code())
        with self.store.db() as c:
            c.execute('UPDATE oauth_grants SET expires=1')
        with self.assertRaises(APIError):
            self.store.authenticate_mcp('Bearer ' + tokens['access_token'])
        self.assertEqual(self.oauth.connections(self.user['id'])['connections'][0]['status'], 'expired')

    def test_revoked_and_expired_attempts_never_look_like_active_connections(self):
        tx = self.oauth.begin(self.params, 'https://euterpe.example')
        self.oauth.bind(tx, self.user['id'], 'session-proof')
        with patch('mcp_oauth.time.time', return_value=time.time() + 601):
            self.assertEqual(self.oauth.connections(self.user['id'])['attempts'][0]['status'], 'expired')
        tokens = self.exchange(self.code())
        connection = self.oauth.connections(self.user['id'])['connections'][0]
        self.oauth.revoke_connection(self.user['id'], connection['id'])
        self.oauth.revoke_connection(self.user['id'], connection['id'])
        self.assertEqual(self.oauth.connections(self.user['id'])['connections'][0]['status'], 'revoked')
        with self.assertRaises(APIError):
            self.refresh(tokens['refresh_token'])


class ConnectionsHTTPTests(unittest.TestCase):
    setUpClass = classmethod(oauth_tests.OAuthHTTPTests.setUpClass.__func__)
    tearDownClass = classmethod(oauth_tests.OAuthHTTPTests.tearDownClass.__func__)
    setUp = oauth_tests.OAuthHTTPTests.setUp
    account = oauth_tests.OAuthHTTPTests.account
    request = oauth_tests.OAuthHTTPTests.request
    form = oauth_tests.OAuthHTTPTests.form
    registration = oauth_tests.OAuthHTTPTests.registration
    authorize = oauth_tests.OAuthHTTPTests.authorize
    approve = oauth_tests.OAuthHTTPTests.approve
    callback = oauth_tests.OAuthHTTPTests.callback
    token = oauth_tests.OAuthHTTPTests.token

    def test_api_is_owner_scoped_csrf_protected_and_mcp_errors_are_not_usage(self):
        auth, _ = self.account()
        other, _ = self.account()
        client = self.registration()
        tokens = self.token(client, self.approve(client, auth))[1]
        self.assertEqual(self.request('/api/mcp/connections')[0], 401)
        self.assertEqual(self.request('/api/mcp/connections', auth=other)[1]['connections'], [])
        connection = self.request('/api/mcp/connections', auth=auth)[1]['connections'][0]
        headers = {'Authorization': 'Bearer ' + tokens['access_token'], 'Accept': 'application/json, text/event-stream'}
        self.request('/mcp', 'POST', {'jsonrpc': '2.0', 'id': 1, 'method': 'unknown'}, headers=headers)
        self.assertEqual(self.request('/api/mcp/connections', auth=auth)[1]['connections'][0]['status'], 'authorized')
        self.request('/mcp', 'POST', {'jsonrpc': '2.0', 'id': 1, 'method': 'ping'}, headers=headers)
        self.assertEqual(self.request('/api/mcp/connections', auth=auth)[1]['connections'][0]['status'], 'used')
        route = '/api/mcp/connections/' + connection['id']
        self.assertEqual(self.request(route, 'DELETE', {}, other)[0], 404)
        self.assertEqual(self.request(route, 'DELETE', {}, (auth[0], 'wrong'))[0], 403)
        self.assertEqual(self.request(route, 'DELETE', {}, auth)[0], 200)
        self.assertEqual(self.request('/mcp', headers=headers)[0], 401)
