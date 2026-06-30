section "SOCKS5 Proxy (Dante)"

echo "Setting up SOCKS5 proxy on port 1080..."
openfoxy add sock_user sock_pass 1080 socks5 || {
  fail "add socks5 proxy"
  return
}
pass "add socks5 proxy command"

sleep 2
wait_for_port 1080 || {
  fail "dante listening on 1080"
  return
}
pass "dante listening on 1080"

assert_http "SOCKS5 proxy forwards request" "200" \
  --socks5-hostname sock_user:sock_pass@127.0.0.1:1080 https://icanhazip.com

assert_fail "SOCKS5 proxy rejects bad credentials" \
  curl -s -o /dev/null --max-time 5 --socks5-hostname wrong:wrong@127.0.0.1:1080 https://icanhazip.com

echo "Tearing down SOCKS5 proxy..."
openfoxy delete sock_user 1080
pass "delete socks5 proxy"
