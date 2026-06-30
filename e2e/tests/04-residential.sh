section "Residential Relay Network"

echo "Setting up residential master on port 9000 + consumer on 8083..."
openfoxy add res_user res_pass 8083 residential || {
  fail "add residential proxy"
  return
}
pass "add residential proxy command"

sleep 3
wait_for_port 9000 40 || {
  fail "gateway listening on 9000"
  return
}
pass "gateway listening on 9000"
wait_for_port 8083 10 || {
  fail "consumer port 8083"
  return
}
pass "consumer listening on 8083"

TOKEN=$(grep -o '"providerToken"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/openfoxy.json | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  fail "provider token stored in database"
  return
fi
openfoxy provider 127.0.0.1:9000:"$TOKEN" --quiet > /tmp/openfoxy-provider-04.log 2>&1 &
PROVIDER_PID=$!
pass "provider started with token"

echo "Waiting for provider to connect..."
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
  pass "provider connected to gateway"

  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    --socks5-hostname res_user:res_pass@127.0.0.1:8083 https://icanhazip.com) || CODE="000"
  if [ "$CODE" = "200" ]; then
    pass "SOCKS5 residential proxy forwards request"
  else
    fail "SOCKS5 residential proxy forwards request (HTTP $CODE)"
  fi

  CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 \
    -x http://res_user:res_pass@127.0.0.1:8083 https://icanhazip.com) || CODE="000"
  if [ "$CODE" = "200" ]; then
    pass "HTTP CONNECT residential proxy forwards request"
  else
    fail "HTTP CONNECT residential proxy forwards request (HTTP $CODE)"
  fi

  assert_fail "HTTP CONNECT rejects bad credentials" \
    curl -s -o /dev/null --max-time 10 \
    -x http://res_user:wrong@127.0.0.1:8083 https://icanhazip.com
else
  fail "provider connected to gateway (timeout waiting for state)"
  skip "SOCKS5 residential proxy forwards request (no provider)"
  skip "HTTP CONNECT residential proxy forwards request (no provider)"
fi

assert_output "status shows residential provider pool" "RESIDENTIAL" openfoxy status

echo "Tearing down residential proxy..."
kill "$PROVIDER_PID" > /dev/null 2>&1 || true
openfoxy delete res_user 8083
pass "delete residential proxy"
