#!/bin/bash
set -euo pipefail

VPN_IP=$(grep -Po 'Endpoint\s=\s\K[^:]*' $CONFIG_LOCATION)

# Our IP address should be the VPN endpoint for the duration of the
# container, so this function will give us a true or false if our IP is
# actually the same as the VPN's
function has_vpn_ip {
    echo "CHECKING"
    echo `curl icanhazip.com/`
    curl --silent --show-error --retry 3 --fail  icanhazip.com/ | \
        grep $VPN_IP | cat
    echo "NEXT"
}

# Handle shutdown behavior
finish () {
    echo "$(date): Shutting down Wireguard"
    wg-quick down $CONFIG_LOCATION
    exit 0
}

# If our container is terminated or interrupted, we'll be tidy and bring down
# the vpn
trap finish TERM INT

echo "$(date) Initialising IP checks!"
curl 1.1.1.1
    echo `curl --show-error --fail icanhazip.com/ | \
        grep $VPN_IP | cat`
# Every minute we check to our IP address
while [[ has_vpn_ip ]]; do
    sleep 60;
done

echo "$(date): VPN IP address not detected"