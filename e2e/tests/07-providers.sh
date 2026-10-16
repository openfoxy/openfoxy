section "Provider Management"

echo "Setting up residential proxy for provider tests..."
openfoxy add pm_user pm_pass 8093 residential > /dev/null 2>&1 || {
  fail "add residential proxy"
  return
}
sleep 2
wait_for_port 9000 20 || {
  fail "gateway listening on 9000"
  return
}
pass "gateway up for provider tests"

TOKEN=$(grep -o '"providerToken"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/openfoxy/config.json | head -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  fail "provider token stored for provider tests"
  openfoxy delete pm_user 8093 > /dev/null 2>&1 || true
  return
fi
openfoxy provider 127.0.0.1:9000:"$TOKEN" --quiet > /tmp/openfoxy-provider-07.log 2>&1 &
PROVIDER_PID=$!
pass "provider started for provider tests"

echo "Waiting for provider to connect..."
PROVIDER_IP=""
for i in $(seq 1 30); do
  if [ -f /var/lib/openfoxy/providers.json ]; then
    STATE=$(cat /var/lib/openfoxy/providers.json 2> /dev/null)
    if echo "$STATE" | grep -q '"ip"'; then
      PROVIDER_IP=$(echo "$STATE" | grep -o '"ip"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | cut -d'"' -f4)
      break
    fi
  fi
  sleep 1
done

if [ -z "$PROVIDER_IP" ]; then
  fail "provider connected for management tests"
  kill "$PROVIDER_PID" > /dev/null 2>&1 || true
  openfoxy delete pm_user 8093 > /dev/null 2>&1 || true
  return
fi
pass "provider connected for management tests"

echo "Testing providers list command..."
assert_output "providers list shows connected IP" "$PROVIDER_IP" openfoxy providers

echo "Testing block list..."
openfoxy providers block "$PROVIDER_IP" suspicious > /dev/null 2>&1 || {
  fail "block provider"
  return
}
pass "block provider IP"
assert_output "providers list shows blocked IP" "$PROVIDER_IP" openfoxy providers
assert_output "providers list shows reason" "suspicious" openfoxy providers

sleep 3
PROVIDER_STATE=$(cat /var/lib/openfoxy/providers.json 2> /dev/null)
if echo "$PROVIDER_STATE" | grep -q "$PROVIDER_IP"; then
  fail "blocked provider was disconnected"
else
  pass "blocked provider was disconnected"
fi

CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 \
  --socks5-hostname pm_user:pm_pass@127.0.0.1:8093 https://icanhazip.com 2> /dev/null) || CODE="000"
if [ "$CODE" != "200" ]; then
  pass "proxy rejects with no providers available"
else
  fail "proxy should reject with no providers (got HTTP $CODE)"
fi

echo "Testing unblock..."
openfoxy providers unblock "$PROVIDER_IP" > /dev/null 2>&1 || {
  fail "unblock provider"
  return
}
pass "unblock provider IP"

sleep 5
PROVIDER_BACK=false
for i in $(seq 1 20); do
  if [ -f /var/lib/openfoxy/providers.json ]; then
    STATE=$(cat /var/lib/openfoxy/providers.json 2> /dev/null)
    if echo "$STATE" | grep -q '"ip"'; then
      PROVIDER_BACK=true
      break
    fi
  fi
  sleep 1
done

if [ "$PROVIDER_BACK" = true ]; then
  pass "provider reconnected after unblock"
else
  fail "provider reconnected after unblock (timeout)"
fi

echo "Testing allowlist..."
openfoxy providers allow "$PROVIDER_IP" > /dev/null 2>&1 || {
  fail "allowlist provider"
  return
}
pass "allowlist provider IP"
assert_output "providers list shows allowlist" "$PROVIDER_IP" openfoxy providers

echo "Testing allowlist removal..."
openfoxy providers disallow "$PROVIDER_IP" > /dev/null 2>&1 || {
  fail "disallow provider"
  return
}
pass "disallow provider IP"

ACCESS_FILE=$(cat /etc/openfoxy/access.json 2> /dev/null)
if echo "$ACCESS_FILE" | grep -q "$PROVIDER_IP"; then
  fail "access lists should be empty after unblock/disallow"
else
  pass "access lists are clean"
fi

kill "$PROVIDER_PID" > /dev/null 2>&1 || true
openfoxy delete pm_user 8093 > /dev/null 2>&1 || true
pass "cleanup provider management tests"
