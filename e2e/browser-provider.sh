#!/bin/bash
set -euo pipefail

TOKEN_FILE=/shared/browser-provider-token

for _ in $(seq 1 120); do
  if [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    exec openfoxy provider browser-server:19000:"$TOKEN" --quiet
  fi
  sleep 1
done

echo "Browser e2e provider token was not published in time."
exit 1
