#!/usr/bin/env bash
# Backup / overflow relay on Azure: one burstable VM in one region, same cloud-init as AWS.
# Needs: `az login`.   ACME_EMAIL=you@example.com ./deploy.sh
# Destroy: az group delete -n belay-relay-azw2 --yes
set -euo pipefail
cd "$(dirname "$0")"
: "${ACME_EMAIL:?set ACME_EMAIL (Lets Encrypt contact)}"
DOMAIN=${DOMAIN:-gobelay.com}
LOCATION=${LOCATION:-westus2}; SHORT=${SHORT:-azw2}
SIZE=${SIZE:-Standard_B2ats_v2}  # 2 vCPU burstable, 1 GB, ~$4/mo + egress after the free 100 GB/mo
RG="belay-relay-$SHORT"; VM=relay; HOST="relay-$SHORT.$DOMAIN"

az group create -n "$RG" -l "$LOCATION" -o none
if az vm show -g "$RG" -n "$VM" >/dev/null 2>&1; then
  echo "vm exists, skipping create"
else
  userdata=$(mktemp)
  sed "s/__HOSTNAME__/$HOST/g; s/__ACME_EMAIL__/$ACME_EMAIL/g" ../cloud-init.yaml >"$userdata"
  az vm create -g "$RG" -n "$VM" --image Ubuntu2404 --size "$SIZE" \
    --admin-username ubuntu --generate-ssh-keys --custom-data "$userdata" \
    --public-ip-sku Standard --public-ip-address-allocation static --nsg-rule SSH -o none
  rm -f "$userdata"
fi

nsg=$(az network nsg list -g "$RG" --query '[0].name' -o tsv)
open_port() { # name proto priority ports...
  local rname=$1 proto=$2 prio=$3; shift 3
  az network nsg rule show -g "$RG" --nsg-name "$nsg" -n "$rname" >/dev/null 2>&1 ||
    az network nsg rule create -g "$RG" --nsg-name "$nsg" -n "$rname" --priority "$prio" \
      --protocol "$proto" --destination-port-ranges "$@" --access Allow -o none
}
open_port relay-tcp Tcp 200 80 443
open_port relay-quic Udp 210 7842

ip=$(az vm show -d -g "$RG" -n "$VM" --query publicIps -o tsv)
echo "A  $HOST -> $ip   (DNS-only, not proxied). Check: curl -sI https://$HOST/generate_204"
echo "Add https://$HOST to RELAY_URLS and EXPO_PUBLIC_RELAY_URLS."
