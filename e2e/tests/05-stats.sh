section "Traffic Statistics"

openfoxy add stat_user stat_pass 8090 http > /dev/null 2>&1 || true
sleep 2

curl -s -o /dev/null --max-time 10 \
  -x http://stat_user:stat_pass@127.0.0.1:8090 https://icanhazip.com > /dev/null 2>&1 || true

STATUS_OUT=$(openfoxy status 2>&1) || true

if echo "$STATUS_OUT" | grep -q "Port 8090"; then
  pass "status lists port 8090"
else
  fail "status lists port 8090"
fi

if echo "$STATUS_OUT" | grep -q "HTTP"; then
  pass "status shows HTTP protocol label"
else
  fail "status shows HTTP protocol label"
fi

if echo "$STATUS_OUT" | grep -q "Traffic"; then
  pass "status shows traffic section"
else
  fail "status shows traffic section"
fi

if echo "$STATUS_OUT" | grep -q "Squid"; then
  pass "status reports squid service state"
else
  fail "status reports squid service state"
fi

openfoxy delete stat_user 8090 > /dev/null 2>&1 || true
