#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  python - <<'PY'
from pathlib import Path
import secrets
p = Path('.env')
s = p.read_text()
s = s.replace('APP_PASSWORD=change-this-before-start', 'APP_PASSWORD=' + secrets.token_urlsafe(24))
s = s.replace('SESSION_SECRET=replace-with-at-least-32-random-characters', 'SESSION_SECRET=' + secrets.token_urlsafe(48))
p.write_text(s)
p.chmod(0o600)
PY
fi
python - <<'PY'
from pathlib import Path
import os
p = Path('.env')
lines = p.read_text().splitlines()
values = {'APP_UID': str(os.getuid()), 'APP_GID': str(os.getgid())}
for key, value in values.items():
    prefix = key + '='
    if any(line.startswith(prefix) for line in lines):
        lines = [prefix + value if line.startswith(prefix) else line for line in lines]
    else:
        lines.append(prefix + value)
p.write_text('\n'.join(lines) + '\n')
p.chmod(0o600)
PY
mkdir -p data secrets
chmod 700 secrets data
if [[ ! -f secrets/todoist-token ]]; then
  touch secrets/todoist-token
  chmod 600 secrets/todoist-token
fi
printf 'Created/checked private environment. Set TODOIST_TOKEN in .env or put the API token in secrets/todoist-token. The generated app password is stored in .env.\n'
