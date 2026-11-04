"""Run after `wam package-inline .`: pass every install-form value (runtipi/config.json form_fields) into the
container. The builder's inline template only passes PORT, DATA_DIR and the trusted hosts/origins, so without this
step the installed app never receives the agent's dashboard address and login and can't reach the engine.

    wam package-inline . && python3 tools/package_env.py
"""
import base64
import json
import re
import zlib
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
DEFAULTS = {'WIZARD_IMPORTER_HERMES_URL': 'http://hermes-agent:9119', 'HERMES_DASHBOARD_BASIC_AUTH_USERNAME': 'hermes'}


def main():
    path = ROOT / 'runtipi/docker-compose.yml'
    compose = yaml.safe_load(path.read_text('utf-8'))
    env = compose['services']['importer']['environment']
    for field in json.loads((ROOT / 'runtipi/config.json').read_text('utf-8'))['form_fields']:
        var = field['env_variable']
        env[var] = '${%s:-%s}' % (var, DEFAULTS.get(var, ''))
    compress_payload(compose['services']['importer'])
    path.write_text(yaml.safe_dump(compose, sort_keys=False, width=100000), 'utf-8')


LIMIT = 131072  # Linux MAX_ARG_STRLEN: one exec argument longer than this fails with "argument list too long"


def compress_payload(service):
    """The inline template ships every file as one base64 JSON argument; past 128 KiB the container can't start.
    Re-encode it zlib-compressed (stdlib only, same runpy start)."""
    cmd = service.get('command') or []
    for i, arg in enumerate(cmd):
        m = re.search(r"json\.loads\(base64\.b64decode\('([A-Za-z0-9+/=]+)'\)\)", arg)
        if not m:
            continue
        raw = base64.b64decode(m.group(1))
        packed = base64.b64encode(zlib.compress(raw, 9)).decode()
        arg = arg.replace(m.group(0), "json.loads(zlib.decompress(base64.b64decode('%s')))" % packed)
        arg = arg.replace('import base64,', 'import base64,zlib,', 1)
        cmd[i] = arg
    for arg in cmd:
        if len(arg.encode()) >= LIMIT:
            raise SystemExit(f'start command is {len(arg.encode())} bytes, over the {LIMIT}-byte exec limit')


if __name__ == '__main__':
    main()
