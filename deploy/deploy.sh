#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-${ROOT_DIR}/.env}"
DEPLOY_USER="${DEPLOY_USER:-root}"
DEPLOY_HOST="${DEPLOY_HOST:-204.168.222.115}"
DEPLOY_PATH="${DEPLOY_PATH:-/opt/sullilink}"
DEPLOY_TARGET="${DEPLOY_USER}@${DEPLOY_HOST}"
SSH_OPTS=(
  -o ConnectTimeout=10
  -o StrictHostKeyChecking=accept-new
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)
RUNTIME_KEYS=(
  API_PORT
  BRAIN_API_URL
  TELEGRAM_BOT_TOKEN
  TELEGRAM_DEFAULT_CHAT_ID
  TELEGRAM_ALLOWED_CHAT_IDS
  TELEGRAM_BOT_OFFSET_FILE
  GMAIL_CLIENT_ID
  GMAIL_CLIENT_SECRET
  GMAIL_REFRESH_TOKEN
  GMAIL_ACCESS_TOKEN
  GMAIL_TOKEN_URL
  GMAIL_REDIRECT_URI
  GMAIL_PROPERTYRADAR_QUERY
  GMAIL_PROPERTYRADAR_MAX_RESULTS
  PROPERTYRADAR_FEED_INTERVAL_MS
  REALESTATETOOL_URL
)

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

wait_for_ssh() {
  local attempts="${1:-24}"
  local sleep_seconds="${2:-5}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if ssh "${SSH_OPTS[@]}" "${DEPLOY_TARGET}" "true" >/dev/null 2>&1; then
      return 0
    fi
    echo "Waiting for SSH on ${DEPLOY_TARGET} (${i}/${attempts})..."
    sleep "${sleep_seconds}"
  done

  echo "SSH did not become ready on ${DEPLOY_TARGET}" >&2
  return 1
}

run_with_retry() {
  local label="$1"
  shift
  local attempts="${RETRY_ATTEMPTS:-6}"
  local i

  for ((i = 1; i <= attempts; i += 1)); do
    if "$@"; then
      return 0
    fi
    echo "${label} failed (${i}/${attempts}). Retrying..."
    wait_for_ssh 6 5 || true
  done

  echo "${label} failed after ${attempts} attempts." >&2
  return 1
}

for cmd in ssh rsync python3; do
  require_cmd "$cmd"
done

if [[ ! -f "${LOCAL_ENV_FILE}" ]]; then
  echo "Local env file not found: ${LOCAL_ENV_FILE}" >&2
  exit 1
fi

remote_env_payload="$(mktemp)"
remote_finish_script="$(mktemp)"
cleanup() {
  rm -f "${remote_env_payload}"
  rm -f "${remote_finish_script}"
}
trap cleanup EXIT

python3 - "$LOCAL_ENV_FILE" "${RUNTIME_KEYS[@]}" >"${remote_env_payload}" <<'PY'
import sys
from pathlib import Path

env_path = Path(sys.argv[1])
wanted = set(sys.argv[2:])
lines = env_path.read_text().splitlines()
values = {}

for raw in lines:
    line = raw.strip()
    if not line or line.startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    values[key] = value

api_port = values.get("API_PORT", "3100")
values["API_PORT"] = api_port
values["BRAIN_API_URL"] = values.get("BRAIN_API_URL") or f"http://127.0.0.1:{api_port}"
values["TELEGRAM_ALLOWED_CHAT_IDS"] = (
    values.get("TELEGRAM_ALLOWED_CHAT_IDS") or values.get("TELEGRAM_DEFAULT_CHAT_ID", "")
)
values["TELEGRAM_BOT_OFFSET_FILE"] = values.get("TELEGRAM_BOT_OFFSET_FILE") or "data/telegram-bot-offset.json"
values["PROPERTYRADAR_FEED_INTERVAL_MS"] = values.get("PROPERTYRADAR_FEED_INTERVAL_MS") or "300000"

for key in sys.argv[2:]:
    if key in values and values[key] != "":
        print(f"{key}={values[key]}")
PY

DEPLOY_COMMIT="$(git -C "${ROOT_DIR}" rev-parse --short HEAD)"
cat >"${remote_finish_script}" <<EOF
#!/usr/bin/env bash
set -euo pipefail

DEPLOY_PATH='${DEPLOY_PATH}'
DEPLOY_COMMIT='${DEPLOY_COMMIT}'
LOG_DIR='/tmp/sullilink-deploy'
LOG_FILE="\${LOG_DIR}/finish.log"
EXIT_FILE="\${LOG_DIR}/finish.exit"

mkdir -p "\${LOG_DIR}"
exec >>"\${LOG_FILE}" 2>&1

if [[ -f /root/.profile ]]; then
  source /root/.profile
fi
if [[ -f /root/.bashrc ]]; then
  source /root/.bashrc
fi
export PATH="/usr/local/bin:/usr/bin:/bin:\${PATH}"

notify() {
  local message="\$1"
  local env_file="\${DEPLOY_PATH}/.env"
  if [[ ! -f "\${env_file}" ]]; then
    return 0
  fi

  local token chat_id
  token="\$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "\${env_file}" | head -n 1)"
  chat_id="\$(sed -n 's/^TELEGRAM_DEFAULT_CHAT_ID=//p' "\${env_file}" | head -n 1)"
  if [[ -z "\${token}" || -z "\${chat_id}" ]]; then
    return 0
  fi

  curl -fsS -X POST "https://api.telegram.org/bot\${token}/sendMessage" \
    --data-urlencode "chat_id=\${chat_id}" \
    --data-urlencode "text=\${message}" >/dev/null || true
}

finalize() {
  local status="\$1"
  printf '%s\n' "\${status}" >"\${EXIT_FILE}"
  if [[ "\${status}" == "0" ]]; then
    notify "SulliLink deploy succeeded on \$(hostname) at commit \${DEPLOY_COMMIT}."
  else
    notify "SulliLink deploy failed on \$(hostname) at commit \${DEPLOY_COMMIT}. Check \${LOG_FILE}."
  fi
}

trap 'status=\$?; finalize "\$status"' EXIT

python3 - <<'PY'
from pathlib import Path

deploy_path = Path("${DEPLOY_PATH}")
remote_env = deploy_path / ".env"
payload = Path("/tmp/sullilink-deploy/runtime.env")

env_map = {}
if remote_env.exists():
    for raw in remote_env.read_text().splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        env_map[key] = value

if payload.exists():
    for raw in payload.read_text().splitlines():
        if not raw or raw.lstrip().startswith("#") or "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        env_map[key] = value

ordered_keys = [
    "POSTGRES_HOST",
    "POSTGRES_PORT",
    "POSTGRES_DB",
    "POSTGRES_USER",
    "POSTGRES_PASSWORD",
    "CHROMA_HOST",
    "CHROMA_PORT",
    "INFERENCE_PROVIDER",
    "ANTHROPIC_API_KEY",
    "OLLAMA_HOST",
    "OPENAI_API_KEY",
    "API_PORT",
    "BRAIN_API_URL",
    "ADMIN_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "TELEGRAM_DEFAULT_CHAT_ID",
    "TELEGRAM_ALLOWED_CHAT_IDS",
    "TELEGRAM_BOT_OFFSET_FILE",
    "GMAIL_CLIENT_ID",
    "GMAIL_CLIENT_SECRET",
    "GMAIL_REFRESH_TOKEN",
    "GMAIL_ACCESS_TOKEN",
    "GMAIL_TOKEN_URL",
    "GMAIL_REDIRECT_URI",
    "GMAIL_PROPERTYRADAR_QUERY",
    "GMAIL_PROPERTYRADAR_MAX_RESULTS",
    "PROPERTYRADAR_FEED_INTERVAL_MS",
    "REALESTATETOOL_URL",
]

rendered = []
seen = set()
for key in ordered_keys:
    if key in env_map:
        rendered.append(f"{key}={env_map[key]}")
        seen.add(key)

for key in sorted(env_map):
    if key not in seen:
        rendered.append(f"{key}={env_map[key]}")

remote_env.write_text("\\n".join(rendered) + "\\n")
PY

cd "\${DEPLOY_PATH}"
mkdir -p data
npm install
npm run migrate
pm2 delete sullilink >/dev/null 2>&1 || true
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save
rm -f /tmp/sullilink-deploy/runtime.env
notify "SulliLink deploy finishing steps are running on \$(hostname) for commit \${DEPLOY_COMMIT}."
EOF

echo "Deploying ${ROOT_DIR} -> ${DEPLOY_TARGET}:${DEPLOY_PATH}"

wait_for_ssh

run_with_retry "Prepare remote directories" \
  ssh "${SSH_OPTS[@]}" "${DEPLOY_TARGET}" "mkdir -p '${DEPLOY_PATH}' '${DEPLOY_PATH}/data' /tmp/sullilink-deploy"

run_with_retry "Sync repository" \
  rsync -az --delete \
    --exclude '.git/' \
    --exclude '.env' \
    --exclude 'node_modules/' \
    --exclude 'data/' \
    --exclude '.DS_Store' \
    -e "ssh ${SSH_OPTS[*]}" \
    "${ROOT_DIR}/" "${DEPLOY_TARGET}:${DEPLOY_PATH}/"

run_with_retry "Upload runtime env payload" \
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    "${remote_env_payload}" "${DEPLOY_TARGET}:/tmp/sullilink-deploy/runtime.env"

run_with_retry "Upload remote finisher" \
  rsync -az -e "ssh ${SSH_OPTS[*]}" \
    "${remote_finish_script}" "${DEPLOY_TARGET}:/tmp/sullilink-deploy/finish.sh"

run_with_retry "Start remote finisher" \
  ssh "${SSH_OPTS[@]}" "${DEPLOY_TARGET}" "chmod +x /tmp/sullilink-deploy/finish.sh && pkill -f '/tmp/sullilink-deploy/finish.sh' >/dev/null 2>&1 || true; nohup /tmp/sullilink-deploy/finish.sh >/tmp/sullilink-deploy/finish.launch.log 2>&1 < /dev/null &"

echo "Deploy started. The remote finisher will complete npm install, migrations, and PM2 restart server-side."
