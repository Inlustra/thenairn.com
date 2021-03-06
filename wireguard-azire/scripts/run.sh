#!/bin/bash

if [ -z "$AZIRE_USERNAME" ]; then echo 'Environment variable AZIRE_USERNAME must be specified. Exiting.'; exit 1; fi
if [ -z "$AZIRE_PASSWORD" ]; then echo 'Environment variable AZIRE_PASSWORD must be specified. Exiting.'; exit 1; fi
if [ -z "$AZIRE_LOCATION" ]; then echo 'Environment variable AZIRE_LOCATION must be specified. Exiting.'; exit 1; fi

set -e

CONFIG_LOCATION=/etc/wireguard/azire-wireguard.conf

source /scripts/configure-azire.sh

echo "$(date): Starting Wireguard on interface $CONFIG_LOCATION"
wg-quick up $CONFIG_LOCATION

source /scripts/ensure-connected.sh