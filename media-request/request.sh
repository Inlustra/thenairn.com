#!/bin/sh
set -eu
[ "$#" -eq 1 ] || exit 2
exec /usr/local/bin/node /mnt/user/HQ/thenairn.com/media-request/cli.mjs "$1"
