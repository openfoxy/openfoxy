section "Data Limit Enforcement"

echo "Creating residential proxy with 5KB limit..."
openfoxy add lim_user lim_pass 8091 residential --limit=5KB > /dev/null 2>&1 || {
  fail "add limited proxy"
  return
}
pass "add limited residential proxy (5KB limit)"

sleep 3

LIMIT_DB=$(cat /etc/openfoxy.json 2> /dev/null)
if echo "$LIMIT_DB" | grep -q '"limit"'; then
  pass "limit stored in database"
else
  fail "limit stored in database"
fi

STATUS_OUT=$(openfoxy status 2>&1) || true
if echo "$STATUS_OUT" | grep -q "Limit:"; then
  pass "status displays data limit"
else
  fail "status displays data limit"
fi

wait_for_port 9000 30 || {
  fail "gateway on 9000 for limit test"
  openfoxy delete lim_user 8091 > /dev/null 2>&1
  return
}
pass "gateway listening on 9000"

wait_for_port 8091 15 || {
  fail "consumer on 8091 for limit test"
  openfoxy delete lim_user 8091 > /dev/null 2>&1
  return
}
pass "consumer listening on 8091"

TOKEN=$(grep -o '"providerToken"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/openfoxy.json | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  fail "provider token stored for limit test"
  openfoxy delete lim_user 8091 > /dev/null 2>&1
  return
fi
openfoxy provider 127.0.0.1:9000:"$TOKEN" --quiet > /tmp/openfoxy-provider-06.log 2>&1 &
PROVIDER_PID=$!
pass "provider started for limit test"

PROVIDER_READY=false
for i in $(seq 1 30); do
  if [ -f /var/run/openfoxy_state.json ]; then
    STATE=$(cat /var/run/openfoxy_state.json 2> /dev/null)
    if echo "$STATE" | grep -q '"id"'; then
      PROVIDER_READY=true
      break
    fi
  fi
  sleep 1
done

if [ "$PROVIDER_READY" = true ]; then
  pass "provider connected for limit test"

  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
    --socks5-hostname lim_user:lim_pass@127.0.0.1:8091 https://icanhazip.com) || CODE="000"
  if [ "$CODE" = "200" ]; then
    pass "request succeeds before limit reached"
  else
    fail "request succeeds before limit reached (HTTP $CODE)"
  fi

  echo "Generating traffic to exceed 5KB limit..."
  for i in $(seq 1 20); do
    curl -s -o /dev/null --max-time 5 \
      --socks5-hostname lim_user:lim_pass@127.0.0.1:8091 https://icanhazip.com > /dev/null 2>&1 || true
  done

  echo "Waiting for limit enforcement (syncServers interval ~10s)..."
  LIMIT_ENFORCED=false
  for i in $(seq 1 25); do
    if ! nc -z 127.0.0.1 8091 2> /dev/null; then
      LIMIT_ENFORCED=true
      break
    fi
    sleep 1
  done

  if [ "$LIMIT_ENFORCED" = true ]; then
    pass "consumer port closed after limit exceeded"
  else
    fail "consumer port closed after limit exceeded (port still open after 25s)"
  fi

  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 \
    --socks5-hostname lim_user:lim_pass@127.0.0.1:8091 https://icanhazip.com 2> /dev/null) || CODE="000"
  if [ "$CODE" = "000" ] || [ "$CODE" = "" ]; then
    pass "request rejected after limit exceeded"
  else
    fail "request rejected after limit exceeded (got HTTP $CODE)"
  fi
else
  fail "provider connected for limit test (timeout)"
  skip "request succeeds before limit reached"
  skip "consumer port closed after limit exceeded"
  skip "request rejected after limit exceeded"
fi

kill "$PROVIDER_PID" > /dev/null 2>&1 || true
openfoxy delete lim_user 8091 > /dev/null 2>&1 || true
pass "cleanup limited proxy"
