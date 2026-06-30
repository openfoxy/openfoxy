section "Password Hot-Reload"

openfoxy add chg_user old_pass 8092 http
rc-service squid restart 2> /dev/null || true
sleep 3
wait_for_port 8092 10 || {
  fail "squid listening on 8092 for change test"
  return
}
pass "squid listening on 8092 for change test"

assert_http "old credentials work" "200" \
  -x http://chg_user:old_pass@127.0.0.1:8092 https://icanhazip.com

assert_fail "wrong credentials rejected" \
  curl -s -o /dev/null --max-time 10 -x http://chg_user:wrong@127.0.0.1:8092 https://icanhazip.com

echo "Changing password..."
openfoxy change chg_user new_pass
pass "change password command"

sleep 2

assert_http "new credentials work" "200" \
  -x http://chg_user:new_pass@127.0.0.1:8092 https://icanhazip.com

assert_fail "old credentials rejected after change" \
  curl -s -o /dev/null --max-time 10 -x http://chg_user:old_pass@127.0.0.1:8092 https://icanhazip.com

openfoxy delete chg_user 8092 > /dev/null 2>&1 || true
pass "cleanup change test"

section "Change --limit and --country"

openfoxy add chg_res chg_pass 8096 residential --limit=1KB > /dev/null 2>&1 || {
  fail "add residential for change-flag test"
  return
}
pass "add residential for change-flag test"
sleep 2

CHG_DB=$(cat /etc/openfoxy.json 2> /dev/null)
if echo "$CHG_DB" | grep -q '"limit"'; then
  pass "initial limit stored in database"
else
  fail "initial limit stored in database"
fi

echo "Changing limit via --limit flag..."
openfoxy change chg_res --limit=10KB > /dev/null 2>&1
CHG_DB2=$(cat /etc/openfoxy.json 2> /dev/null)
if echo "$CHG_DB2" | grep -q "10240"; then
  pass "limit updated to 10KB in database"
else
  fail "limit updated to 10KB in database"
fi

echo "Changing country via --country flag..."
openfoxy change chg_res --country=DE > /dev/null 2>&1
CHG_DB3=$(cat /etc/openfoxy.json 2> /dev/null)
if echo "$CHG_DB3" | grep -q '"DE"'; then
  pass "country updated to DE in database"
else
  fail "country updated to DE in database"
fi

echo "Removing limit with --limit=0..."
openfoxy change chg_res --limit=0 > /dev/null 2>&1
CHG_DB4=$(cat /etc/openfoxy.json 2> /dev/null)
CHG_RES_ENTRY=$(echo "$CHG_DB4" | grep -o '"limit":[^,}]*' | head -1)
if echo "$CHG_RES_ENTRY" | grep -q "null"; then
  pass "limit removed from database"
else
  fail "limit removed from database (got: $CHG_RES_ENTRY)"
fi

echo "Clearing country with --country=..."
openfoxy change chg_res --country= > /dev/null 2>&1
CHG_DB5=$(cat /etc/openfoxy.json 2> /dev/null)
CHG_COUNTRY=$(echo "$CHG_DB5" | grep -o '"country":[^,}]*' | head -1)
if echo "$CHG_COUNTRY" | grep -q "null"; then
  pass "country cleared from database"
else
  fail "country cleared from database (got: $CHG_COUNTRY)"
fi

openfoxy delete chg_res 8096 > /dev/null 2>&1 || true
pass "cleanup change-flag test"
