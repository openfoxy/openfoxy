section "HTTP Proxy (Squid)"

echo "Setting up HTTP proxy on port 8080..."
openfoxy add http_user http_pass 8080 http || {
  fail "add http proxy"
  return
}
pass "add http proxy command"

sleep 2
wait_for_port 8080 || {
  fail "squid listening on 8080"
  return
}
pass "squid listening on 8080"

assert_http "HTTP proxy forwards request" "200" \
  -x http://http_user:http_pass@127.0.0.1:8080 https://icanhazip.com

assert_fail "HTTP proxy rejects bad credentials" \
  curl -s -o /dev/null --max-time 10 -x http://wrong:wrong@127.0.0.1:8080 https://icanhazip.com

assert_fail "HTTP proxy blocks unauthenticated request" \
  curl -s -o /dev/null --max-time 5 -x http://127.0.0.1:8080 https://icanhazip.com

echo "Tearing down HTTP proxy..."
openfoxy delete http_user 8080
pass "delete http proxy"
