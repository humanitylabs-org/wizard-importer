import base64, json, sys, unittest, zlib
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'tools'))
import package_env


class CompressTests(unittest.TestCase):
    def test_big_payload_fits_exec_limit_and_round_trips(self):
        files = {'web/app.js': 'x = 1;\n' * 40000}
        b64 = base64.b64encode(json.dumps(files).encode()).decode()
        self.assertGreater(len(b64), package_env.LIMIT)
        svc = {'command': ['python', '-c', "import base64,json,pathlib,runpy\nfiles=json.loads(base64.b64decode('%s'))" % b64]}
        package_env.compress_payload(svc)
        arg = svc['command'][2]
        self.assertLess(len(arg), package_env.LIMIT)
        ns = {}
        exec(arg, ns)
        self.assertEqual(ns['files'], files)

    def test_shipped_compose_fits(self):
        import yaml
        compose = yaml.safe_load((Path(__file__).resolve().parent.parent / 'runtipi/docker-compose.yml').read_text())
        for arg in compose['services']['importer']['command']:
            self.assertLess(len(arg.encode()), package_env.LIMIT)


if __name__ == '__main__':
    unittest.main()
