#!/bin/bash
set -euo pipefail

PASS=0
FAIL=0
TOTAL=0
SKIP=0

pass() {
  PASS=$((PASS + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ✅ $1"
}

fail() {
  FAIL=$((FAIL + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ❌ $1"
}

skip() {
  SKIP=$((SKIP + 1))
  TOTAL=$((TOTAL + 1))
  echo "  ⏭️  $1"
}

assert_exit() {
  local desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    pass "$desc"
  else
    fail "$desc"
  fi
}

assert_fail() {
  local desc="$1"
  shift
  if "$@" > /dev/null 2>&1; then
    fail "$desc"
  else
    pass "$desc"
  fi
}

assert_output() {
  local desc="$1" needle="$2"
  shift 2
  local out
  out=$("$@" 2>&1) || true
  if echo "$out" | grep -q "$needle"; then
    pass "$desc"
  else
    fail "$desc (output missing '$needle')"
  fi
}

assert_http() {
  local desc="$1" expected="$2"
  shift 2
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$@") || code="000"
  if [ "$code" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc (expected HTTP $expected, got $code)"
  fi
}

wait_for_port() {
  local port="$1" tries="${2:-30}"
  while ! nc -z 127.0.0.1 "$port" 2> /dev/null; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then return 1; fi
    sleep 0.5
  done
}

section() {
  echo ""
  echo "━━━ $1 ━━━"
}

echo "🦊 OpenFoxy E2E Test Suite"
echo "═══════════════════════════════════════════"

source /e2e/tests/01-http.sh
source /e2e/tests/02-socks5.sh
source /e2e/tests/03-mtproto.sh
source /e2e/tests/04-residential.sh
source /e2e/tests/05-stats.sh
source /e2e/tests/06-limits.sh
source /e2e/tests/07-providers.sh
source /e2e/tests/08-change.sh
source /e2e/tests/09-lifecycle.sh

echo ""
echo "═══════════════════════════════════════════"
echo "🧪 Results: $PASS passed, $FAIL failed, $SKIP skipped (total $TOTAL)"
echo "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  echo "❌ E2E tests failed."
  exit 1
fi
echo "✅ All E2E tests passed!"
exit 0
