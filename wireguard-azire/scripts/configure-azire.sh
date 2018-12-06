#!/bin/bash
apt install -y jq

wg genkey | tee privatekey | wg pubkey > publickey

WG_PRIVATE_KEY=`cat privatekey`
publickey=`cat publickey`

echo "Calling Azire"
echo "$publickey"
echo "$AZIRE_USERNAME"
echo "$AZIRE_PASSWORD"
echo "$AZIRE_LOCATION"
echo ""

azireoutput=`curl -s -d username=$AZIRE_USERNAME --data-urlencode password=$AZIRE_PASSWORD --data-urlencode pubkey=$publickey https://api.azirevpn.com/v1/wireguard/connect/$AZIRE_LOCATION`
echo "$azireoutput"
status=`echo azireoutput | jq '.status'`
WG_DNS=`echo azireoutput | jq '.data.DNS'`
WG_ADDRESS=`echo azireoutput | jq '.data.Address'`
WG_PUBLIC_KEY=`echo azireoutput | jq '.data.PublicKey'`
WG_ENDPOINT=`echo azireoutput | jq '.data.Endpoint'`



echo "$status"
echo "$WG_PRIVATE_KEY"
echo "$WG_DNS"
echo "$WG_PUBLIC_KEY"
echo "$WG_ENDPOINT"

envsubst < /scripts/azire-wireguard.conf > /etc/wireguard/azire-wireguard.conf
echo `cat /etc/wireguard/azire-wireguard.conf` 