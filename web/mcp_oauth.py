"""Small OAuth authorization server for Euterpe's per-user MCP resource.

No upstream tokens are passed through. SQLite IMMEDIATE transactions serialize
code redemption and refresh rotation; only hashes of bearer secrets persist.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
import urllib.parse
import uuid


def hashed(value):
    return hashlib.sha256(value.encode()).hexdigest()


class McpOAuth:
    def __init__(self, store, error_type):
        self.store, self.error = store, error_type
        with store.db() as c:
            c.executescript('''
                CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY, name TEXT NOT NULL,
                    redirects TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS oauth_requests(hash TEXT PRIMARY KEY, data TEXT NOT NULL,
                    expires REAL NOT NULL, user_id TEXT, session_hash TEXT);
                CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY, data TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id), expires REAL NOT NULL, used INTEGER NOT NULL DEFAULT 0,
                    grant_id TEXT);
                CREATE TABLE IF NOT EXISTS oauth_grants(id TEXT PRIMARY KEY, client_id TEXT NOT NULL,
                    user_id TEXT NOT NULL REFERENCES users(id), scope TEXT NOT NULL, resource TEXT NOT NULL,
                    token_id TEXT NOT NULL, expires REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS oauth_refresh(hash TEXT PRIMARY KEY,
                    grant_id TEXT NOT NULL REFERENCES oauth_grants(id), used INTEGER NOT NULL DEFAULT 0);
                CREATE INDEX IF NOT EXISTS oauth_refresh_grant ON oauth_refresh(grant_id);
            ''')

    def fail(self, code='invalid_request', status=400):
        raise self.error(code, status)

    def register(self, body):
        redirects = body.get('redirect_uris')
        name = body.get('client_name', 'Aplicativo MCP')
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 120:
            self.fail('invalid_client_metadata')
        if not isinstance(redirects, list) or not 1 <= len(redirects) <= 10:
            self.fail('invalid_redirect_uri')
        for uri in redirects:
            try:
                if not isinstance(uri, str) or len(uri) > 2048 or re.search(r'''[\s\x00-\x1f\x7f"'<>\\]''', uri):
                    self.fail('invalid_redirect_uri')
                p = urllib.parse.urlsplit(uri)
                if not p.hostname or p.username or p.password or p.fragment or '#' in uri or not p.port and uri.endswith(':'):
                    self.fail('invalid_redirect_uri')
                if p.scheme != 'https' and not (p.scheme == 'http' and p.hostname in {'127.0.0.1', 'localhost', '::1'}):
                    self.fail('invalid_redirect_uri')
                if any(key in {'code', 'state', 'error', 'iss'} for key in urllib.parse.parse_qs(p.query)):
                    self.fail('invalid_redirect_uri')
            except ValueError:
                self.fail('invalid_redirect_uri')
        if body.get('token_endpoint_auth_method', 'none') != 'none':
            self.fail('invalid_client_metadata')
        if body.get('response_types', ['code']) != ['code']:
            self.fail('invalid_client_metadata')
        grants = body.get('grant_types', ['authorization_code', 'refresh_token'])
        if not isinstance(grants, list) or 'authorization_code' not in grants or any(g not in {'authorization_code', 'refresh_token'} for g in grants):
            self.fail('invalid_client_metadata')
        client_id = 'eut_client_' + secrets.token_urlsafe(24)
        with self.store.db() as c:
            c.execute('BEGIN IMMEDIATE')
            # Bound abandoned DCR registrations without expiring active grants.
            c.execute('DELETE FROM oauth_clients WHERE created<? AND NOT EXISTS '
                      '(SELECT 1 FROM oauth_grants g JOIN mcp_tokens t ON t.id=g.token_id '
                      'WHERE g.client_id=oauth_clients.id AND g.revoked=0 AND g.expires>?)',
                      (time.time() - 90 * 86400, time.time()))
            if c.execute('SELECT count(*) FROM oauth_clients').fetchone()[0] >= 2000:
                self.fail('registration_capacity', 429)
            c.execute('INSERT INTO oauth_clients VALUES (?,?,?,?)', (client_id, name.strip(), json.dumps(redirects), time.time()))
        return {'client_id': client_id, 'client_name': name.strip(), 'redirect_uris': redirects,
                'token_endpoint_auth_method': 'none', 'grant_types': ['authorization_code', 'refresh_token'],
                'response_types': ['code']}

    def begin(self, params, origin):
        client_id = params.get('client_id', '')
        with self.store.db() as c:
            client = c.execute('SELECT * FROM oauth_clients WHERE id=?', (client_id,)).fetchone()
        if not client or params.get('redirect_uri') not in json.loads(client['redirects']):
            self.fail('invalid_client')
        if params.get('response_type') != 'code':
            self.fail('unsupported_response_type')
        challenge = params.get('code_challenge', '')
        if params.get('code_challenge_method') != 'S256' or not re.fullmatch(r'[A-Za-z0-9_-]{43}', challenge):
            self.fail('invalid_request')
        scope = params.get('scope', 'read')
        if scope not in {'read', 'write', 'read write', 'write read'}:
            self.fail('invalid_scope')
        resource = origin + '/mcp'
        if params.get('resource', resource) != resource:
            self.fail('invalid_target')
        if len(params.get('state', '')) > 2048:
            self.fail()
        data = {'client_id': client_id, 'client_name': client['name'], 'redirect_uri': params['redirect_uri'],
                'scope': ' '.join(sorted(set(scope.split()))), 'challenge': challenge,
                'resource': resource, 'state': params.get('state', ''), 'issuer': origin}
        transaction = secrets.token_urlsafe(32)
        with self.store.db() as c:
            c.execute('BEGIN IMMEDIATE')
            c.execute('UPDATE oauth_clients SET created=? WHERE id=?', (time.time(), client_id))
            c.execute('DELETE FROM oauth_requests WHERE expires<=?', (time.time(),))
            if c.execute('SELECT count(*) FROM oauth_requests').fetchone()[0] >= 2000:
                self.fail('authorization_capacity', 429)
            c.execute('INSERT INTO oauth_requests (hash,data,expires,user_id,session_hash) VALUES (?,?,?,NULL,NULL)',
                      (hashed(transaction), json.dumps(data), time.time() + 600))
        return transaction

    def pending(self, transaction):
        if not isinstance(transaction, str) or len(transaction) > 128:
            self.fail()
        with self.store.db() as c:
            row = c.execute('SELECT * FROM oauth_requests WHERE hash=? AND expires>?', (hashed(transaction), time.time())).fetchone()
        if not row:
            self.fail('invalid_authorization_request')
        return dict(row)

    def bind(self, transaction, user_id, session):
        with self.store.db() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT * FROM oauth_requests WHERE hash=? AND expires>?', (hashed(transaction), time.time())).fetchone()
            if not row or row['user_id'] and (row['user_id'] != user_id or row['session_hash'] != hashed(session)):
                self.fail('invalid_authorization_request')
            c.execute('UPDATE oauth_requests SET user_id=?,session_hash=? WHERE hash=?', (user_id, hashed(session), hashed(transaction)))
        return json.loads(row['data'])

    def consent(self, transaction, user_id, session, approved):
        with self.store.db() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT * FROM oauth_requests WHERE hash=? AND expires>?', (hashed(transaction), time.time())).fetchone()
            if not row or row['user_id'] != user_id or row['session_hash'] != hashed(session):
                self.fail('invalid_authorization_request')
            data = json.loads(row['data'])
            result = {'redirect_uri': data['redirect_uri'], 'state': data['state'], 'iss': data['issuer']}
            # Derive the same code for an identical browser form retry. Only
            # hashes persist; reconstruction also needs the raw transaction,
            # which is not stored in the database. A retry cannot mint a new
            # code, change the decision, switch accounts or change sessions.
            code = base64.urlsafe_b64encode(hmac.new(self.store.csrf_key,
                b'euterpe-mcp-consent-code-v1:' + transaction.encode(), hashlib.sha256).digest()).decode().rstrip('=')
            decision = data.get('_consent_approved')
            if decision is not None:
                if decision != approved:
                    self.fail('invalid_authorization_request')
                if approved:
                    prior = c.execute('SELECT expires,used FROM oauth_codes WHERE hash=?', (hashed(code),)).fetchone()
                    if not prior or prior['expires'] <= time.time():
                        self.fail('invalid_authorization_request')
                    if prior['used']:
                        self.fail('authorization_already_completed', 409)
            else:
                # Keep the existing table shape so the previous gateway image
                # can still be used for rollback without a reverse migration.
                c.execute('UPDATE oauth_requests SET data=?,expires=? WHERE hash=?',
                          (json.dumps({**data, '_consent_approved': approved}), time.time() + 120, hashed(transaction)))
                if approved:
                    c.execute('INSERT INTO oauth_codes VALUES (?,?,?,?,0,NULL)', (hashed(code), row['data'], user_id, time.time() + 120))
            if approved:
                result['code'] = code
            else:
                result['error'] = 'access_denied'
        return result

    @staticmethod
    def _revoke(c, grant_id):
        c.execute('DELETE FROM mcp_tokens WHERE id=(SELECT token_id FROM oauth_grants WHERE id=?)', (grant_id,))
        c.execute('UPDATE oauth_grants SET revoked=1 WHERE id=?', (grant_id,))

    def exchange(self, params, origin):
        client_id = params.get('client_id', '')
        invalid = False
        with self.store.db() as c:
            c.execute('BEGIN IMMEDIATE')
            if not c.execute('SELECT 1 FROM oauth_clients WHERE id=?', (client_id,)).fetchone():
                self.fail('invalid_client', 401)
            if params.get('grant_type') == 'authorization_code':
                row = c.execute('SELECT * FROM oauth_codes WHERE hash=?', (hashed(params.get('code', '')),)).fetchone()
                if not row:
                    self.fail('invalid_grant')
                data = json.loads(row['data'])
                verifier = params.get('code_verifier', '')
                challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
                if (data['client_id'] != client_id or params.get('redirect_uri') != data['redirect_uri']
                        or not re.fullmatch(r'[A-Za-z0-9._~-]{43,128}', verifier)
                        or not hmac.compare_digest(challenge, data['challenge'])
                        or params.get('resource', origin + '/mcp') != data['resource'] or data['issuer'] != origin):
                    self.fail('invalid_grant')
                if row['used'] or row['expires'] <= time.time():
                    if row['grant_id']:
                        self._revoke(c, row['grant_id'])
                    invalid = True
                else:
                    if c.execute('SELECT count(*) FROM mcp_tokens WHERE user_id=? AND expires>?', (row['user_id'], time.time())).fetchone()[0] >= 20:
                        self.fail('token_limit', 409)
                    grant_id, token_id = str(uuid.uuid4()), str(uuid.uuid4())
                    c.execute('INSERT INTO oauth_grants VALUES (?,?,?,?,?,?,?,0)',
                              (grant_id, client_id, row['user_id'], data['scope'], data['resource'], token_id, time.time() + 30 * 86400))
                    c.execute('UPDATE oauth_codes SET used=1,grant_id=? WHERE hash=?', (grant_id, row['hash']))
                    grant = c.execute('SELECT * FROM oauth_grants WHERE id=?', (grant_id,)).fetchone()
                    name = 'MCP: ' + data['client_name'][:75]
            elif params.get('grant_type') == 'refresh_token':
                row = c.execute('SELECT r.used,g.* FROM oauth_refresh r JOIN oauth_grants g ON g.id=r.grant_id WHERE r.hash=?',
                                (hashed(params.get('refresh_token', '')),)).fetchone()
                if not row or row['client_id'] != client_id:
                    self.fail('invalid_grant')
                if params.get('resource', origin + '/mcp') != row['resource'] or row['resource'] != origin + '/mcp':
                    self.fail('invalid_target')
                if set(params.get('scope', row['scope']).split()) != set(row['scope'].split()):
                    self.fail('invalid_scope')
                token = c.execute('SELECT name FROM mcp_tokens WHERE id=? AND user_id=?', (row['token_id'], row['user_id'])).fetchone()
                if row['used'] or row['revoked'] or row['expires'] <= time.time() or not token:
                    self._revoke(c, row['id'])
                    invalid = True
                else:
                    c.execute('UPDATE oauth_refresh SET used=1 WHERE hash=?', (hashed(params['refresh_token']),))
                    grant, name = row, token['name']
            else:
                self.fail('unsupported_grant_type')
            if not invalid:
                access, refresh = 'eut_mcp_' + secrets.token_urlsafe(32), secrets.token_urlsafe(48)
                now = time.time()
                c.execute('INSERT INTO mcp_tokens VALUES (?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,expires=excluded.expires',
                          (grant['token_id'], hashed(access), grant['user_id'], name,
                           'write' if 'write' in grant['scope'].split() else 'read', now, now + 3600))
                c.execute('INSERT INTO oauth_refresh VALUES (?,?,0)', (hashed(refresh), grant['id']))
        # Raise after COMMIT: replay revocation must survive the error response.
        if invalid:
            self.fail('invalid_grant')
        return {'access_token': access, 'token_type': 'Bearer', 'expires_in': 3600,
                'refresh_token': refresh, 'scope': grant['scope']}

    def revoke(self, params):
        with self.store.db() as c:
            c.execute('BEGIN IMMEDIATE')
            row = c.execute('SELECT g.id FROM oauth_grants g LEFT JOIN oauth_refresh r ON r.grant_id=g.id '
                            'LEFT JOIN mcp_tokens t ON t.id=g.token_id WHERE g.client_id=? AND (r.hash=? OR t.hash=?) LIMIT 1',
                            (params.get('client_id', ''), hashed(params.get('token', '')), hashed(params.get('token', '')))).fetchone()
            if row:
                self._revoke(c, row['id'])
