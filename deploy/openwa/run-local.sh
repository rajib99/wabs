#!/usr/bin/env bash
# Runs OpenWA on this machine for local observation: pnpm openwa
# First run clones the pinned commit into .data/openwa and builds it; later runs just start it.
# Needs Node 22 (OpenWA does not support newer) and Google Chrome.
set -euo pipefail

# Reviewed commit. To upgrade: read OpenWA's CHANGELOG, change this, delete .data/openwa, rerun.
OPENWA_COMMIT="51e848c"

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DIR="$ROOT/.data/openwa"
cd "$ROOT"
set -a; . ./.env; set +a
: "${OPENWA_API_KEY:?set OPENWA_API_KEY in .env}"

# Find Node 22 without depending on shell setup: nvm's install directory, then Homebrew's node@22.
for candidate in "${NVM_DIR:-$HOME/.nvm}"/versions/node/v22.*/bin /opt/homebrew/opt/node@22/bin /usr/local/opt/node@22/bin; do
  if [[ -x "$candidate/node" ]]; then PATH="$candidate:$PATH"; break; fi
done
[[ "$(node -v)" == v22.* ]] || { echo "OpenWA needs Node 22, found $(node -v). Install it: nvm install 22" >&2; exit 1; }

CHROME="${OPENWA_CHROME_PATH:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
[[ -x "$CHROME" ]] || { echo "Chrome not found at $CHROME. Set OPENWA_CHROME_PATH in .env" >&2; exit 1; }

if [[ ! -f "$DIR/dist/main.js" ]]; then
  rm -rf "$DIR"
  git clone https://github.com/rmyndharis/OpenWA.git "$DIR"
  git -C "$DIR" checkout --quiet "$OPENWA_COMMIT"
  # OpenWA listens on every interface and BIND_HOST only affects its Docker setup. Keep the gateway off the LAN.
  sed -i.orig "s/await app.listen(port);/await app.listen(port, '127.0.0.1');/" "$DIR/src/main.ts"
  grep -q "app.listen(port, '127.0.0.1')" "$DIR/src/main.ts" || { echo "could not bind OpenWA to loopback: check src/main.ts" >&2; rm -rf "$DIR"; exit 1; }
  ( cd "$DIR" && PUPPETEER_SKIP_DOWNLOAD=true npm ci && npm run build:all )
fi

cd "$DIR"
# Written fresh each start so .env stays the single source of truth. Local-only: bound to loopback.
umask 077
cat > .env <<CONF
NODE_ENV=production
PORT=2785
API_MASTER_KEY=$OPENWA_API_KEY
DATABASE_TYPE=sqlite
DATABASE_NAME=./data/openwa.sqlite
ENGINE_TYPE=whatsapp-web.js
SESSION_DATA_PATH=./data/sessions
AUTO_START_SESSIONS=true
PUPPETEER_HEADLESS=true
PUPPETEER_EXECUTABLE_PATH="$CHROME"
PUPPETEER_ARGS=--disable-dev-shm-usage,--disable-gpu
STORAGE_TYPE=local
STORAGE_LOCAL_PATH=./data/media
REDIS_ENABLED=false
QUEUE_ENABLED=false
CACHE_ENABLED=false
CSP_UPGRADE_INSECURE_REQUESTS=false
RESOLVE_LID_TO_PHONE=true
MESSAGE_RETENTION_DAYS=30
WEBHOOK_MEDIA_INLINE_MAX_BYTES=0
MEDIA_DOWNLOAD_MAX_BYTES=20971520
SSRF_ALLOWED_HOSTS=localhost,127.0.0.1
SEND_PACING_ENABLED=true
SEND_PACING_WARMUP_SCHEDULE=20,40,80,160,320,640,1000
SEND_PACING_COLD_DAILY_CAP=5,10,20,40,60,80,100
CONF
exec node dist/main
