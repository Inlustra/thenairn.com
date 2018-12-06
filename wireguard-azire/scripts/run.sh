#!/bin/bash

if [ -z "$AZIRE_USERNAME" ]; then echo 'Environment variable AZIRE_USERNAME must be specified. Exiting.'; exit 1; fi
if [ -z "$AZIRE_PASSWORD" ]; then echo 'Environment variable AZIRE_PASSWORD must be specified. Exiting.'; exit 1; fi
if [ -z "$AZIRE_LOCATION" ]; then echo 'Environment variable AZIRE_LOCATION must be specified. Exiting.'; exit 1; fi

set -e

# Install Wireguard. This has to be done dynamically since the kernel
# module depends on the host kernel version.
apt update
apt install -y wireguard

source /scripts/configure-azire.sh

# Find a Wireguard interface
interfaces=`find /etc/wireguard -type f`
if [[ -z $interfaces ]]; then
    echo "$(date): Interface not found in /etc/wireguard" >&2
    exit 1
fi

interface=`echo $interfaces | head -n 1`

echo "$(date): Starting Wireguard"
wg-quick up $interface

# Handle shutdown behavior
finish () {
    echo "$(date): Shutting down Wireguard"
    wg-quick down $interface
    exit 0
}

trap finish SIGTERM SIGINT SIGQUIT

sleep infinity &
wait $!