"""Run after `wam package-inline .`: pass every install-form value (runtipi/config.json form_fields) into the
container. The builder's inline template only passes PORT, DATA_DIR and the trusted hosts/origins, so without this
step the installed app never receives the agent's dashboard address and login and can't reach the engine.

    wam package-inline . && python3 tools/package_env.py
"""
import json
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
    path.write_text(yaml.safe_dump(compose, sort_keys=False, width=100000), 'utf-8')


if __name__ == '__main__':
    main()
