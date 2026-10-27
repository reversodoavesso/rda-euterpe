"""SSO boundaries: PKCE, canonical identity and explicit local-account linking."""
import base64
import hashlib
from pathlib import Path
import tempfile
import unittest
from urllib.parse import urlsplit, parse_qs

from rda_sso import RdaSso, SsoError, hashed
from server import Store, APIError, COOKIE, digest

ISSUER = 'https://id.reversodoavesso.com'
PROFILE = {'id': 'platform-1', 'sub': 'subject-1', 'issuer': ISSUER, 'role': 'acolyte', 'displayName': 'Synthetic'}


class SsoTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.profile = dict(PROFILE)
        def request(url, body=None, headers=None):
            self.calls.append((url, body, headers))
            if url.endswith('openid-configuration'):
                return {'issuer': ISSUER, 'authorization_endpoint': ISSUER + '/authorize', 'token_endpoint': ISSUER + '/token'}
            if url.endswith('/token'):
                return {'access_token': 'synthetic-token', 'expires_in': 300}
            return self.profile
        self.sso = RdaSso('http://127.0.0.1:18339', 'client', 'project', requester=request)

    def test_pkce_state_and_replay(self):
        url, cookie = self.sso.start()
        query = parse_qs(urlsplit(url).query)
        identity = self.sso.finish({'state': query['state'][0], 'code': 'synthetic-code'}, cookie)
        token_call = next(call for call in self.calls if call[0].endswith('/token'))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(token_call[1]['code_verifier'].encode()).digest()).decode().rstrip('=')
        self.assertEqual(query['code_challenge'], [challenge])
        self.assertEqual(token_call[1]['redirect_uri'], 'http://127.0.0.1:18339/api/account/sso/callback')
        self.assertEqual(identity['profile'], PROFILE)
        with self.assertRaises(SsoError):
            self.sso.finish({'state': query['state'][0], 'code': 'synthetic-code'}, cookie)

    def test_mismatched_state_never_exchanges_code(self):
        _, cookie = self.sso.start()
        with self.assertRaises(SsoError):
            self.sso.finish({'state': 'wrong', 'code': 'code'}, cookie)
        self.assertEqual(len(self.calls), 1)

    def test_identity_issuer_and_live_revocation(self):
        url, cookie = self.sso.start()
        identity = self.sso.finish({'state': parse_qs(urlsplit(url).query)['state'][0], 'code': 'code'}, cookie)
        self.sso.remember('session', identity)
        self.assertEqual(self.sso.verify_session('session', PROFILE['sub'])['id'], PROFILE['id'])
        identity['checked'] = 0
        self.profile['issuer'] = 'https://attacker.invalid'
        with self.assertRaises(SsoError):
            self.sso.verify_session('session', PROFILE['sub'])
        self.assertNotIn(hashed('session'), self.sso.sessions)


class LinkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.store = Store(Path(self.temp.name))
        self.user = self.store.register({'username': 'synthetic', 'password': 'synthetic-password-123', 'display_name': 'Synthetic'})
        self.token = self.store.issue_session(self.user['id'])

    def tearDown(self):
        self.temp.cleanup()

    def test_link_preserves_data_and_retires_password_sessions_and_tickets(self):
        ticket = self.store.ticket(self.user['id'])
        with self.store.db() as c:
            c.execute('INSERT INTO conversations VALUES (?,?,?,?,?)', ('11111111-1111-4111-8111-111111111111', self.user['id'], 'Preserved', 1, 1))
        linked = self.store.bind_sso(PROFILE, self.user['id'], digest(self.token))
        self.assertEqual(linked['id'], self.user['id'])
        self.assertEqual(linked['number'], self.user['number'])
        self.assertEqual(self.store.conversation(linked['id'], '11111111-1111-4111-8111-111111111111')['title'], 'Preserved')
        with self.assertRaises(APIError): self.store.login({'username': 'synthetic', 'password': 'synthetic-password-123'})
        with self.assertRaises(APIError): self.store.authenticate(COOKIE + '=' + self.token)
        with self.assertRaises(APIError): self.store.consume_ticket(ticket)
        with self.assertRaises(APIError): self.store.ticket(linked['id'])

    def test_never_matches_name_or_email_and_requires_live_local_proof(self):
        profile = {**PROFILE, 'displayName': 'synthetic', 'email': 'synthetic@example.invalid'}
        separate = self.store.bind_sso(profile)
        self.assertNotEqual(separate['id'], self.user['id'])
        with self.assertRaises(APIError): self.store.bind_sso({**PROFILE, 'sub': 'different'}, self.user['id'], 'forged-session')
        other = self.store.register({'username': 'another', 'password': 'synthetic-password-123'})
        proof = self.store.issue_session(other['id'])
        with self.assertRaises(APIError): self.store.bind_sso(PROFILE, other['id'], digest(proof))


if __name__ == '__main__':
    unittest.main()
