#!/bin/bash
apt install -y jq

wg genkey | tee privatekey | wg pubkey > publickey

export WG_PRIVATE_KEY=`cat privatekey`
publickey=`cat publickey`

echo "Calling Azire"

azireoutput=`curl -s -d username=$AZIRE_USERNAME --data-urlencode password=$AZIRE_PASSWORD --data-urlencode pubkey=$publickey https://api.azirevpn.com/v1/wireguard/connect/$AZIRE_LOCATION`
status=`jq -r '.status' <<< "$azireoutput"`

if [ "$status" != "success" ]
then
echo "Unsuccesful azire API."
echo "$azireoutput"
exit
fi

export WG_DNS=`jq -r '.data.DNS' <<< "$azireoutput"`
export WG_ADDRESS=`jq -r '.data.Address' <<< "$azireoutput"`
export WG_PUBLIC_KEY=`jq -r '.data.PublicKey' <<< "$azireoutput"`
export WG_ENDPOINT=`jq -r '.data.Endpoint' <<< "$azireoutput"`


envsubst < /scripts/azire-wireguard.conf > $CONFIG_LOCATION
echo `cat $CONFIG_LOCATION`