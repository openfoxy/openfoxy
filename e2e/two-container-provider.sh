#!/bin/bash
set -euo pipefail

TOKEN_FILE=/shared/provider-token

echo "Provider waiting for residential token..."
for _ in $(seq 1 90); do
  if [ -s "$TOKEN_FILE" ]; then
    TOKEN=$(cat "$TOKEN_FILE")
    echo "Provider connecting to server:9000..."
    exec openfoxy provider server:9000:"$TOKEN" --quiet
  fi
  sleep 1
done

echo "Provider token was not published in time."
exit 1
