"""Exercita daemon e autostart em diretórios temporários, sem tocar o perfil real."""
import base64
import json
import os
from pathlib import Path
import plistlib
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request

exe = Path(sys.argv[1]).resolve()
if os.name == 'nt' and exe.suffix != '.exe':
    exe = exe.with_suffix('.exe')

with tempfile.TemporaryDirectory(prefix='euterpe-lifecycle-') as temporary:
    root = Path(temporary) / "João's data & space"
    root.mkdir()
    env = {**os.environ, 'EUTERPE_DATA_DIR': str(root / 'data'),
           'APPDATA': str(root), 'HOME': str(root), 'XDG_CONFIG_HOME': str(root / 'config'),
           'HOST': '127.0.0.1', 'WS_SECRET': 'isolated-smoke-secret'}
    with socket.socket() as reservation:
        reservation.bind(('127.0.0.1', 0))
        env['PORT'] = str(reservation.getsockname()[1])
    url = 'http://127.0.0.1:' + env['PORT'] + '/health'
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))

    def health():
        try:
            with opener.open(url, timeout=1) as response:
                return json.load(response)
        except (OSError, ValueError):
            return None

    def wait_ready():
        for _ in range(100):
            result = health()
            if result and result.get('app') == 'euterpe':
                return result
            time.sleep(.1)
        raise AssertionError('daemon did not become ready')

    def run(*args):
        process = subprocess.Popen([str(exe), *args], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            stdout, stderr = process.communicate(timeout=40)
        except subprocess.TimeoutExpired:
            # Um daemon que herdou pipes mantém communicate aberto após o pai sair.
            current = health()
            if current and current.get('pid'):
                os.kill(current['pid'], signal.SIGTERM)
            process.kill()
            process.communicate(timeout=10)
            raise
        assert process.returncode == 0, (args, stdout, stderr)
        return stdout

    print('Testing foreground daemon and idempotent start...', flush=True)
    child = subprocess.Popen([str(exe), 'serve'], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        first = wait_ready()
        assert first['pid'] == child.pid
        assert Path(first['executable']).resolve() == exe
        run('--ensure')
        run('serve')
        assert health()['pid'] == child.pid, 'duplicate daemon'
    finally:
        child.terminate()
        try:
            child.wait(timeout=20)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()
            raise AssertionError('daemon did not handle shutdown')
    if os.name != 'nt':
        assert child.returncode == 0, 'SIGTERM should shut down gracefully'

    detached = None
    print('Testing detached start with captured output...', flush=True)
    try:
        run('--ensure')
        detached = wait_ready()['pid']
        run('--ensure')
        assert health()['pid'] == detached
    finally:
        # Limpeza restrita ao PID do daemon criado com o diretório temporário.
        if detached is None:
            current = health()
            detached = current.get('pid') if current else None
        if detached:
            os.kill(detached, signal.SIGTERM)
            for _ in range(100):
                if not health():
                    break
                time.sleep(.1)
            assert not health(), 'detached daemon did not stop'

    # Os gerenciadores Unix são substituídos; nenhum serviço real é registrado.
    print('Testing isolated autostart registration/removal...', flush=True)
    fake_bin = root / 'bin'
    fake_bin.mkdir()
    if sys.platform in ('linux', 'darwin'):
        command = fake_bin / ('systemctl' if sys.platform == 'linux' else 'launchctl')
        command.write_text('#!/bin/sh\nif [ "$1" = "print" ]; then exit 1; fi\nexit 0\n')
        command.chmod(0o755)
        env['PATH'] = str(fake_bin) + os.pathsep + env['PATH']
    run('install-startup')
    run('install-startup')  # Reinstalação idempotente.
    if os.name == 'nt':
        link = root / 'Microsoft/Windows/Start Menu/Programs/Startup/Euterpe.lnk'
        env['EUTERPE_TEST_LINK'] = str(link)
        args = subprocess.check_output(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
            '(New-Object -ComObject WScript.Shell).CreateShortcut($env:EUTERPE_TEST_LINK).Arguments'], env=env, text=True).strip()
        assert '-WindowStyle Hidden' in args
        script = base64.b64decode(args.split('-EncodedCommand ')[1]).decode('utf-16-le')
        assert "João''s data & space" in script
        assert '--ensure' in script
        artifact = link
    elif sys.platform == 'darwin':
        artifact = root / 'Library/LaunchAgents/app.euterpe.daemon.plist'
        with artifact.open('rb') as f:
            plist = plistlib.load(f)
        assert plist['ProgramArguments'] == [str(exe), 'serve']
        assert plist['EnvironmentVariables']['EUTERPE_DATA_DIR'] == env['EUTERPE_DATA_DIR']
    else:
        artifact = root / 'config/systemd/user/euterpe.service'
        assert 'Restart=on-failure' in artifact.read_text()
        assert not (root / 'config/autostart/euterpe.desktop').exists()
    run('install-startup', '--remove')
    assert not artifact.exists()
    run('install-startup', '--remove')
    if sys.platform == 'linux':
        command.write_text('#!/bin/sh\nexit 1\n')
        run('install-startup')
        desktop = root / 'config/autostart/euterpe.desktop'
        assert '--ensure' in desktop.read_text()
        run('install-startup', '--remove')
        assert not desktop.exists()
print('PASS: serve, ensure, single instance, shutdown, isolated autostart install/remove')
