"""Exercise generated routing on an isolated loopback Nginx, never a deployed server."""

import http.client
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import deploy_tools as deploy


NGINX = os.environ.get('Q_NGINX_BIN') or shutil.which('nginx')


@unittest.skipUnless(NGINX, 'Local Nginx unavailable; set Q_NGINX_BIN for routing checks')
class AdminNginxRoutes(unittest.TestCase):
    document = b'<html><script src="/q-admin/assets/app.js"></script></html>'

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.temporary = tempfile.TemporaryDirectory(prefix='q-admin-nginx-')
        cls.addClassCleanup(cls.temporary.cleanup)
        cls.root = Path(cls.temporary.name)
        # CI runs Nginx with an unprivileged worker even when its test process is root.
        cls.root.chmod(0o755)
        (cls.root / 'logs').mkdir()
        public = cls.root / 'site/current/public/q-admin'
        (public / 'assets').mkdir(parents=True)
        (public / 'index.html').write_bytes(cls.document)
        (public / 'privacy.html').write_bytes(b'<html>Public document</html>')
        (public / 'guide.HTML').write_bytes(b'<html>Public document</html>')
        (public / 'assets/app.js').write_bytes(b'console.log("fixture")')
        (public / 'version.json').write_bytes(b'{"mode":"admin"}')
        with socket.socket() as available, socket.socket() as redirect:
            available.bind(('127.0.0.1', 0))
            redirect.bind(('127.0.0.1', 0))
            cls.port = available.getsockname()[1]
            cls.redirect_port = redirect.getsockname()[1]
        with patch.object(deploy, 'BASE', cls.root / 'site'):
            snippet = deploy.snippet('https')
            http_snippet = deploy.snippet('http')
        config = cls.root / 'nginx.conf'
        # This listener checks Nginx location/header behavior. TLS verification has
        # separate smoke tests; no public listener or API upstream is created here.
        config.write_text(
            f'pid "{cls.root}/nginx.pid";\nerror_log stderr warn;\ndaemon off;\n'
            'events {}\nhttp { access_log off; types { text/html html; application/javascript js; }\n'
            f'server {{ listen 127.0.0.1:{cls.port}; server_name q.kaicloudpay.com 8.163.108.216;\n'
            f'{snippet}\nlocation / {{ return 404; }}\n}}\n'
            f'server {{ listen 127.0.0.1:{cls.redirect_port}; server_name 8.163.108.216;\n'
            f'{http_snippet}\nlocation / {{ return 404; }}\n}}\n}}\n'
        )
        command = [NGINX, '-p', str(cls.root) + '/', '-c', str(config)]
        subprocess.run([*command, '-t'], check=True, capture_output=True)
        cls.log = (cls.root / 'stderr.log').open('wb')
        cls.addClassCleanup(cls.log.close)
        cls.process = subprocess.Popen(command, stdout=cls.log, stderr=cls.log)
        cls.addClassCleanup(cls.stop_nginx)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            if cls.process.poll() is not None:
                raise RuntimeError((cls.root / 'stderr.log').read_text())
            try:
                connection = http.client.HTTPConnection('127.0.0.1', cls.port, timeout=0.2)
                connection.request('GET', '/q-admin/version.json')
                response = connection.getresponse()
                response.read()
                connection.close()
                if response.status == 200:
                    return
            except (OSError, http.client.HTTPException):
                pass
            time.sleep(0.02)
        raise RuntimeError('Isolated Nginx did not become ready')

    @classmethod
    def stop_nginx(cls):
        cls.process.terminate()
        try:
            cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.wait(timeout=5)

    def request(self, path, host='q.kaicloudpay.com', headers=None, port=None):
        connection = http.client.HTTPConnection('127.0.0.1', port or self.port, timeout=2)
        try:
            connection.request('GET', path, headers={'Host': host, **(headers or {})})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def test_entry_legacy_urls_and_direct_reload_keep_document_policy(self):
        for host in ('q.kaicloudpay.com', '8.163.108.216'):
            for path in ('/q-admin/', '/q-admin/index.html', '/q-admin/users',
                         '/q-admin/wallet-payments', '/q-admin/wallet-payments/',
                         '/q-admin/wallet-payments/refunds', '/q-admin/plugins/detail?tab=history'):
                with self.subTest(host=host, path=path):
                    status, headers, body = self.request(path, host)
                    self.assertEqual(status, 200)
                    self.assertEqual(body, self.document)
                    self.assertEqual(headers['Cache-Control'], 'no-store')
                    self.assertIn("connect-src 'self';", headers['Content-Security-Policy'])
                    self.assertNotIn('https:', headers['Content-Security-Policy'])
                    # Re-loading a saved/history address must receive the same document policy.
                    again_status, again_headers, again_body = self.request(path, host, {'Cache-Control': 'no-cache'})
                    self.assertEqual((again_status, again_body), (status, body))
                    for name in ('Cache-Control', 'Content-Security-Policy'):
                        self.assertEqual(again_headers[name], headers[name])

    def test_existing_html_document_keeps_api_policy(self):
        for path in ('/q-admin/privacy.html', '/q-admin/guide.HTML'):
            with self.subTest(path=path):
                status, headers, _ = self.request(path)
                self.assertEqual(status, 200)
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertIn("connect-src 'self';", headers['Content-Security-Policy'])

    def test_assets_and_version_keep_their_static_policies(self):
        status, headers, body = self.request('/q-admin/assets/app.js')
        self.assertEqual(status, 200)
        self.assertEqual(body, b'console.log("fixture")')
        self.assertEqual(headers['Cache-Control'], 'public, max-age=31536000, immutable')
        self.assertIn("connect-src 'none';", headers['Content-Security-Policy'])
        status, headers, _ = self.request('/q-admin/version.json')
        self.assertEqual(status, 200)
        self.assertEqual(headers['Cache-Control'], 'no-store')
        self.assertIn("connect-src 'none';", headers['Content-Security-Policy'])

    def test_missing_files_do_not_receive_the_spa_or_immutable_caching(self):
        for path in ('/q-admin/assets/missing.js', '/q-admin/wallet-payments/missing.js',
                     '/q-admin/missing.svg', '/q-admin/missing.html',
                     '/q-admin/mascot/01-running.png', '/q-admin/mascot/08-complete.png'):
            with self.subTest(path=path):
                status, headers, body = self.request(path)
                self.assertEqual(status, 404)
                self.assertNotEqual(body, self.document)
                self.assertNotIn('immutable', headers.get('Cache-Control', ''))
                self.assertEqual(headers['X-Content-Type-Options'], 'nosniff')

    def test_canonical_entry_preserves_query_without_creating_a_cross_origin_api_policy(self):
        # The upstream hop is plain HTTP after trusted TLS termination. The
        # Location must stay relative, including on the legacy HTTPS IP host.
        for host in ('q.kaicloudpay.com', '8.163.108.216'):
            with self.subTest(host=host):
                status, headers, _ = self.request('/q-admin?tab=orders', host)
                self.assertEqual(status, 308)
                self.assertEqual(headers['Location'], '/q-admin/?tab=orders')
                self.assertEqual(headers['Cache-Control'], 'no-store')
                self.assertIn("connect-src 'none';", headers['Content-Security-Policy'])
        # The separate legacy public HTTP listener must still upgrade to HTTPS.
        for path, target in (('/q-admin?tab=orders', '/q-admin/?tab=orders'),
                             ('/q-admin/users?tab=orders', '/q-admin/users?tab=orders')):
            with self.subTest(legacy_http=path):
                status, headers, _ = self.request(path, '8.163.108.216', port=self.redirect_port)
                self.assertEqual(status, 308)
                self.assertEqual(headers['Location'], 'https://8.163.108.216' + target)


if __name__ == '__main__':
    unittest.main()
