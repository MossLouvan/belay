#!/usr/bin/env bash
# One iroh-relay per region on AWS Lightsail. Idempotent: existing instances / IPs are kept.
# Needs: aws CLI logged in (`aws sts get-caller-identity` works). Creates nothing but Lightsail.
#   ACME_EMAIL=you@example.com ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

: "${ACME_EMAIL:?set ACME_EMAIL (Lets Encrypt contact)}"
DOMAIN=${DOMAIN:-gobelay.com}
BUNDLE=${BUNDLE:-small_3_0}        # $12/mo: 2 vCPU, 2 GB, 60 GB SSD, 3 TB transfer (halved in some APAC regions)
BLUEPRINT=${BLUEPRINT:-ubuntu_24_04}
# region:short-name. Hostname = relay-<short>.<DOMAIN>
REGIONS=${REGIONS:-"us-east-1:use1 eu-central-1:euc1 ap-southeast-1:apse1"}
DNS=""

exists() { aws lightsail "$1" --region "$2" --"$3" "$4" >/dev/null 2>&1; }

for pair in $REGIONS; do
  region=${pair%%:*}; short=${pair##*:}
  name="belay-relay-$short"; host="relay-$short.$DOMAIN"
  echo "== $region  $host"

  if exists get-instance "$region" instance-name "$name"; then
    echo "   instance $name exists, skipping create"
  else
    userdata=$(mktemp)
    sed "s/__HOSTNAME__/$host/g; s/__ACME_EMAIL__/$ACME_EMAIL/g" ../cloud-init.yaml >"$userdata"
    aws lightsail create-instances --region "$region" \
      --instance-names "$name" --availability-zone "${region}a" \
      --blueprint-id "$BLUEPRINT" --bundle-id "$BUNDLE" \
      --user-data "file://$userdata" \
      --tags key=belay,value=relay >/dev/null
    rm -f "$userdata"
    echo "   created $name"
  fi

  if ! exists get-static-ip "$region" static-ip-name "$name-ip"; then
    aws lightsail allocate-static-ip --region "$region" --static-ip-name "$name-ip" >/dev/null
  fi
  until [ "$(aws lightsail get-instance --region "$region" --instance-name "$name" --query instance.state.name --output text)" = running ]; do
    sleep 5
  done
  attached=$(aws lightsail get-static-ip --region "$region" --static-ip-name "$name-ip" --query staticIp.attachedTo --output text)
  if [ "$attached" != "$name" ]; then
    aws lightsail attach-static-ip --region "$region" --static-ip-name "$name-ip" --instance-name "$name" >/dev/null
  fi

  # Lightsail firewall. put-* replaces the whole list, so re-running is harmless.
  # 80 = ACME + captive portal, 443 = relay WebSocket, 7842/udp = QUIC address discovery
  # (iroh-relay DEFAULT_RELAY_QUIC_PORT; the relay does not speak STUN/3478).
  aws lightsail put-instance-public-ports --region "$region" --instance-name "$name" --port-infos \
    'fromPort=22,toPort=22,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' \
    'fromPort=80,toPort=80,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' \
    'fromPort=443,toPort=443,protocol=tcp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' \
    'fromPort=7842,toPort=7842,protocol=udp,cidrs=0.0.0.0/0,ipv6Cidrs=::/0' >/dev/null

  ip4=$(aws lightsail get-static-ip --region "$region" --static-ip-name "$name-ip" --query staticIp.ipAddress --output text)
  ip6=$(aws lightsail get-instance --region "$region" --instance-name "$name" --query 'instance.ipv6Addresses[0]' --output text)
  DNS="$DNS
  A     $host  -> $ip4"
  [ "$ip6" != None ] && DNS="$DNS
  AAAA  $host  -> $ip6"
done

cat <<MSG

DNS records to create (Cloudflare: DNS-only / grey cloud, NOT proxied; the relay terminates
its own TLS and speaks WebSocket + QUIC):$DNS
  CNAME relay.$DOMAIN -> relay-use1.$DOMAIN

relay.$DOMAIN is only the fallback the app ships when EXPO_PUBLIC_RELAY_URLS is unset
(app/src/account/tunnel-key.ts). Point it at the region nearest most users, and ship ALL
relays in EXPO_PUBLIC_RELAY_URLS and the Worker's RELAY_URLS: iroh measures latency to each
URL at bind time and picks the closest. Do not round-robin one name across regions: both
peers must agree on a home relay, and iroh does that per URL, not per IP.
Let's Encrypt completes a minute or two after DNS resolves (the relay retries).
Check each:  curl -sI https://$host/generate_204   (expect HTTP 204)
MSG
