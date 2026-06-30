#!/bin/bash
set -euo pipefail

PASS=0
FAIL=0
TOTAL=0

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

finish() {
  openfoxy delete res_user 8083 > /dev/null 2>&1 || true
  rm -f /shared/provider-token
  echo ""
  echo "═══════════════════════════════════════════"
  echo "Two-container residential results: $PASS passed, $FAIL failed (total $TOTAL)"
  echo "═══════════════════════════════════════════"
  if [ "$FAIL" -gt 0 ]; then exit 1; fi
}
trap finish EXIT

wait_for_port() {
  local host="$1" port="$2" tries="${3:-60}"
  while ! nc -z "$host" "$port" 2> /dev/null; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then return 1; fi
    sleep 0.5
  done
}

assert_code() {
  local desc="$1" expected="$2"
  shift 2
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "$@") || code="000"
  if [ "$code" = "$expected" ]; then
    pass "$desc"
  else
    fail "$desc (expected HTTP $expected, got $code)"
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

echo "🦊 OpenFoxy Two-Container Residential Test"
echo "═══════════════════════════════════════════"

openfoxy add res_user res_pass 8083 residential --gateway=9000 > /tmp/openfoxy-two-container-add.log 2>&1 \
  && pass "server created residential proxy" \
  || {
    fail "server created residential proxy"
    exit 1
  }

wait_for_port 127.0.0.1 9000 80 && pass "server gateway listens on 9000" || {
  fail "server gateway listens on 9000"
  exit 1
}
wait_for_port 127.0.0.1 8083 40 && pass "server consumer listens on 8083" || {
  fail "server consumer listens on 8083"
  exit 1
}

TOKEN=$(grep -o '"providerToken"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/openfoxy.json | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  fail "server stored provider token"
  exit 1
fi
printf '%s' "$TOKEN" > /shared/provider-token
pass "server published provider token"

CONNECTED=false
for _ in $(seq 1 90); do
  if [ -f /var/run/openfoxy_state.json ] && grep -q '"id"' /var/run/openfoxy_state.json; then
    CONNECTED=true
    break
  fi
  sleep 1
done

if [ "$CONNECTED" = true ]; then
  pass "separate provider container connected"
else
  fail "separate provider container connected"
  exit 1
fi

assert_code "SOCKS5 residential relay forwards via provider container" "200" \
  --socks5-hostname res_user:res_pass@127.0.0.1:8083 https://icanhazip.com

assert_code "HTTP CONNECT residential relay forwards via provider container" "200" \
  -x http://res_user:res_pass@127.0.0.1:8083 https://icanhazip.com

assert_fail "HTTP CONNECT rejects bad credentials" \
  curl -s -o /dev/null --max-time 10 -x http://res_user:wrong@127.0.0.1:8083 https://icanhazip.com

if openfoxy status | grep -q "Residential Provider Pool"; then
  pass "status shows connected provider pool"
else
  fail "status shows connected provider pool"
fi
