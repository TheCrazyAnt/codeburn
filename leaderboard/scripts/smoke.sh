#!/usr/bin/env bash
# Local smoke test: boots `wrangler dev --local` on a random port, applies the
# D1 migrations to the local database, curls the unauthenticated endpoints, and
# shuts the dev server down again. No Cloudflare login required.
set -euo pipefail

cd "$(dirname "$0")/.."

PORT="${PORT:-$(( 20000 + RANDOM % 20000 ))}"
LOG="$(mktemp -t codeburn-smoke.XXXXXX)"

npx wrangler d1 migrations apply codeburn-leaderboard --local >/dev/null

npx wrangler dev --local --port "$PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
cleanup() {
  kill "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
  rm -f "$LOG"
}
trap cleanup EXIT

BASE="http://127.0.0.1:$PORT"
for _ in $(seq 1 60); do
  if curl -fsS "$BASE/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done

fail=0
check() { # check <label> <expected-substring> <actual>
  if [[ "$3" == *"$2"* ]]; then echo "PASS  $1"; else echo "FAIL  $1 — expected '$2' in: $3"; fail=1; fi
}

check "GET /healthz"                   "ok"                 "$(curl -sS "$BASE/healthz")"
check "GET /v1/config"                 "uploadIntervalMinutes" "$(curl -sS "$BASE/v1/config")"
check "GET /  (html, zh-CN)"           'lang="zh-CN"'        "$(curl -sS "$BASE/")"
check "GET /v1/leaderboard"            '"board":"month"'     "$(curl -sS "$BASE/v1/leaderboard")"
check "GET /v1/leaderboard CORS"       "access-control-allow-origin: *" "$(curl -sS -D - -o /dev/null "$BASE/v1/leaderboard" | tr -d '\r' | tr 'A-Z' 'a-z')"
check "POST /v1/report no auth → 401"  "unauthorized"       "$(curl -sS -X POST "$BASE/v1/report" -H 'content-type: application/json' -d '{}')"
check "POST /v1/session bad body → 400" "invalid_field"     "$(curl -sS -X POST "$BASE/v1/session" -H 'content-type: application/json' -d '{"appVersion":"1"}')"
check "GET /nope → 404"                "not_found"          "$(curl -sS "$BASE/nope")"

exit $fail
