#!/bin/bash
apt install -y jq

wg genkey | tee privatekey | wg pubkey > publickey

export WG_PRIVATE_KEY=`cat privatekey`
publickey=`cat publickey`

echo "Calling Azire"
echo "$publickey"
echo "$AZIRE_USERNAME"
echo "$AZIRE_PASSWORD"
echo "$AZIRE_LOCATION"
echo ""

azireoutput=`curl -s -d username=$AZIRE_USERNAME --data-urlencode password=$AZIRE_PASSWORD --data-urlencode pubkey=$publickey https://api.azirevpn.com/v1/wireguard/connect/$AZIRE_LOCATION`
echo "$azireoutput"
status=`jq -r '.status' <<< "$azireoutput"`
export WG_DNS=`jq -r '.data.DNS' <<< "$azireoutput"`
export WG_ADDRESS=`jq -r '.data.Address' <<< "$azireoutput"`
export WG_PUBLIC_KEY=`jq -r '.data.PublicKey' <<< "$azireoutput"`
export WG_ENDPOINT=`jq -r '.data.Endpoint' <<< "$azireoutput"`



echo "$status"
echo "$WG_PRIVATE_KEY"
echo "$WG_DNS"
echo "$WG_PUBLIC_KEY"
echo "$WG_ENDPOINT"

envsubst < /scripts/azire-wireguard.conf > /etc/wireguard/azire-wireguard.conf
echo `cat /etc/wireguard/azire-wireguard.conf` 