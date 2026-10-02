#!/usr/bin/env bash
# Deletes the Lightsail relays and releases their static IPs (an unattached IP is billed).
set -euo pipefail
REGIONS=${REGIONS:-"us-east-1:use1 eu-central-1:euc1 ap-southeast-1:apse1"}
for pair in $REGIONS; do
  region=${pair%%:*}; name="belay-relay-${pair##*:}"
  if aws lightsail delete-instance --region "$region" --instance-name "$name" >/dev/null 2>&1; then
    echo "deleted $name ($region)"
  fi
  if aws lightsail release-static-ip --region "$region" --static-ip-name "$name-ip" >/dev/null 2>&1; then
    echo "released $name-ip"
  fi
done
