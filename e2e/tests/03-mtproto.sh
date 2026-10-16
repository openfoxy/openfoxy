section "MTProto Proxy (MTG)"

echo "Setting up MTProto proxy on port 8082..."
openfoxy add mt_user mt_pass 8082 mtproto || {
  fail "add mtproto proxy"
  return
}
pass "add mtproto proxy command"

sleep 2
if wait_for_port 8082 20; then
  pass "mtg listening on 8082"
else
  fail "mtg listening on 8082"
fi

assert_output "list shows mtproto proxy" "MTPROTO" openfoxy list
assert_output "list shows a FakeTLS Telegram link" "tg://proxy?server=.*&port=8082&secret=ee" openfoxy list
assert_output "status shows the mtg service running" "MTProto :8082 .*RUNNING" openfoxy status

assert_output "status shows traffic section" "Traffic" openfoxy status

echo "Tearing down MTProto proxy..."
openfoxy delete mt_user 8082
pass "delete mtproto proxy"
