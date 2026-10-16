#!/bin/bash
set -euo pipefail

cleanup() {
  openfoxy delete browser_http 18080 > /dev/null 2>&1 || true
  openfoxy delete browser_socks 11080 > /dev/null 2>&1 || true
  openfoxy delete browser_res 18083 > /dev/null 2>&1 || true
  rm -f /shared/browser-provider-token /shared/browser-ready
}
trap cleanup EXIT

wait_for_port() {
  local port="$1" tries="${2:-80}"
  while ! nc -z 127.0.0.1 "$port" 2> /dev/null; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then return 1; fi
    sleep 0.5
  done
}

echo "Preparing browser e2e proxies..."
openfoxy add browser_http http_pass 18080 http
openfoxy add browser_socks socks_pass 11080 socks5
openfoxy add browser_res res_pass 18083 residential --gateway=19000

wait_for_port 18080
wait_for_port 11080
wait_for_port 18083
wait_for_port 19000

TOKEN=$(grep -o '"providerToken"[[:space:]]*:[[:space:]]*"[^"]*"' /etc/openfoxy/config.json | tail -1 | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "Residential provider token missing."
  exit 1
fi
printf '%s' "$TOKEN" > /shared/browser-provider-token

for _ in $(seq 1 120); do
  if [ -f /var/lib/openfoxy/providers.json ] && grep -q '"id"' /var/lib/openfoxy/providers.json; then
    touch /shared/browser-ready
    echo "Browser e2e proxies are ready."
    tail -f /dev/null &
    wait $!
  fi
  sleep 1
done

echo "Residential provider did not connect in time."
exit 1
