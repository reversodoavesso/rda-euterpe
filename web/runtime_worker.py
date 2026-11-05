"""Private container worker: Spotify + daemon, persistent /data, no account UI."""
import hmac
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import signal
import subprocess
import threading
import time


def configure_shared_provider(root, env):
    """Register the ecosystem provider without persisting its credential in config."""
    url = env.get('RDA_AI_URL')
    if not url:
        return
    key = env.get('RDA_AI_API_KEY')
    if not key:
        raise ValueError('RDA AI credential required')
    from urllib.parse import urlsplit
    parsed = urlsplit(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Invalid RDA AI URL')
    chat = env.get('RDA_AI_MODEL', 'rda/chat-default')
    curation = env.get('RDA_AI_CURATION_MODEL', 'rda/reasoning')
    path = root / 'daemon/config.json'
    config = json.loads(path.read_text()) if path.exists() else {}
    providers = [p for p in config.get('providers', []) if p.get('id') != 'rda']
    providers.append({'id': 'rda', 'name': 'RDA AI', 'kind': 'openai-compat',
                      'base_url': url.rstrip('/') + '/v1', 'defaultModel': chat,
                      'curationModel': curation, 'models': [chat, curation]})
    config.update(providers=providers, activeProvider='rda')
    path.write_text(json.dumps(config, indent=2) + '\n')
    path.chmod(0o600)
    env.update(EUTERPE_PROVIDER='rda', EUTERPE_RDA_API_KEY=key,
               LLM_CHAT_MODEL=chat, LLM_CURATION_MODEL=curation)


def activate_shared_provider(root, env, secret):
    if not env.get('RDA_AI_URL'):
        return
    deadline = time.monotonic() + 45
    while True:
        conn = http.client.HTTPConnection('127.0.0.1', 8337, timeout=2)
        try:
            conn.request('GET', '/settings', headers={'Authorization': 'Bearer ' + secret})
            response = conn.getresponse()
            if response.status != 200:
                raise OSError('Daemon not ready')
            settings = json.loads(response.read())['settings']
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise RuntimeError('RDA provider activation timed out')
            time.sleep(0.25)
        finally:
            conn.close()
    baseline = root / 'daemon/settings-before-rda-ai.json'
    if not baseline.exists():
        baseline.write_text(json.dumps(settings, indent=2) + '\n'); baseline.chmod(0o600)
    profiles = [p for p in settings.get('profiles', []) if p['id'] not in ('rda-chat', 'rda-curation')]
    for ident, name, model in [('rda-chat', 'RDA Chat', env['LLM_CHAT_MODEL']), ('rda-curation', 'RDA Curadoria', env['LLM_CURATION_MODEL'])]:
        profiles.append({'id': ident, 'name': name, 'provider': 'rda', 'model': model, 'max_tokens': 4096})
    patch = {'activeProvider': 'rda', 'activeModel': env['LLM_CHAT_MODEL'], 'curationModel': env['LLM_CURATION_MODEL'],
             'profiles': profiles, 'activeProfile': 'rda-chat', 'roleProfiles': {'chat': 'rda-chat', 'curation': 'rda-curation'},
             'sessionOverrides': {k: 'rda-chat' for k in settings.get('sessionOverrides', {})}}
    conn = http.client.HTTPConnection('127.0.0.1', 8337, timeout=5)
    try:
        conn.request('PUT', '/settings', json.dumps(patch), {'Authorization': 'Bearer ' + secret, 'Content-Type': 'application/json'})
        response = conn.getresponse()
        if response.status != 200 or json.loads(response.read())['settings']['activeProvider'] != 'rda':
            raise RuntimeError('RDA provider activation failed')
    finally:
        conn.close()


def main():
    os.umask(0o077)
    root = Path('/data')
    for name in ['daemon', 'spotify', 'tmp']:
        (root / name).mkdir(parents=True, exist_ok=True, mode=0o700)
    secret = os.environ['DAEMON_KEY']
    spotify_secret = os.environ['SPOTIFY_KEY']
    env = {**os.environ, 'HOME': str(root), 'TMPDIR': '/data/tmp', 'TOKIO_WORKER_THREADS': '2', 'GOMAXPROCS': '2'}
    spotify_env = {**env, 'SPOTIFY_STATE_FILE': '/data/spotify/state.json', 'SPOTIFY_PAIRING_ENABLED': 'true',
                   'SPOTIFY_SERVICE_SECRET': spotify_secret, 'LISTEN_ADDR': '127.0.0.1:8336'}
    daemon_env = {**env, 'HOST': '127.0.0.1', 'PORT': '8337', 'EUTERPE_DATA_DIR': '/data/daemon',
                  'WS_SECRET': secret, 'EUTERPE_HEADLESS_URL': 'http://127.0.0.1:8336',
                  'EUTERPE_HEADLESS_SECRET': spotify_secret, 'EUTERPE_MUTATION_POLICY': 'confirm', 'EUTERPE_SUGGESTIONS': 'false'}
    configure_shared_provider(root, daemon_env)
    children = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def handle_request(self):
            if self.path != '/health' and not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + secret):
                self.send_error(401)
                return
            if self.path == '/health':
                healthy = len(children) == 2 and all(p.poll() is None for p in children)
                for port in [8336, 8337]:
                    conn = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    try:
                        conn.request('GET', '/health', headers={'Authorization': 'Bearer ' + (spotify_secret if port == 8336 else secret)})
                        healthy = conn.getresponse().status == 200 and healthy
                    except OSError:
                        healthy = False
                    finally:
                        conn.close()
                self.send_response(200 if healthy else 503)
                self.end_headers()
                self.wfile.write(json.dumps({'ready': healthy}).encode())
                return
            spotify = self.path == '/runtime/spotify-health'
            conn = http.client.HTTPConnection('127.0.0.1', 8336 if spotify else 8337, timeout=150)
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if size < 0 or size > 8 * 1024 * 1024:
                    self.send_error(413)
                    return
                body = self.rfile.read(size) if size else None
                conn.request(self.command, '/health' if spotify else self.path, body,
                             {'Authorization': 'Bearer ' + (spotify_secret if spotify else secret), 'Content-Type': 'application/json'})
                response = conn.getresponse()
                self.send_response(response.status)
                self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                self.end_headers()
                while True:
                    chunk = response.read1(8192)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    self.wfile.flush()
            finally:
                conn.close()

        do_GET = do_POST = do_PUT = do_DELETE = handle_request

    server = ThreadingHTTPServer(('0.0.0.0', 18080), Handler)
    server.daemon_threads = True
    def stop(*_):
        threading.Thread(target=server.shutdown, daemon=True).start()
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        children.append(subprocess.Popen(['/usr/local/bin/euterpe-headless'], env=spotify_env))
        children.append(subprocess.Popen(['/usr/local/bin/euterpe', 'serve'], env=daemon_env))
        activate_shared_provider(root, daemon_env, secret)
        server.serve_forever()
    finally:
        server.server_close()
        for process in children:
            process.terminate()
        for process in children:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


if __name__ == '__main__':
    main()
