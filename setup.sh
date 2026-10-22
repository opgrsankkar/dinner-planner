#!/usr/bin/env bash
# Creates a private .env with the host UID/GID and a random calendar-feed token.
set -euo pipefail
cd "$(dirname "$0")"
umask 077
[[ -f .env ]] || cp .env.example .env
set_value() {
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi
}
set_value APP_UID "$(id -u)"
set_value APP_GID "$(id -g)"
grep -q '^ICS_TOKEN=.\{20,\}' .env || set_value ICS_TOKEN "$(head -c 32 /dev/urandom | base64 | tr '+/' '-_' | tr -d '=')"
mkdir -p data
chmod 700 data
echo "Private .env ready. Start with: docker compose up -d --build"
