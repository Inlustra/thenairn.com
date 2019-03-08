FROM ubuntu:16.04

# Thanks to https://nbsoftsolutions.com/blog/routing-select-docker-containers-through-wireguard-vpn
RUN apt-get update -y && \
    apt-get install -y jq && \
    apt-get install -y gettext-base && \
    apt-get install -y software-properties-common && \
    apt-get install -y iptables && \
    apt-get install -y curl && \
    apt-get install -y iproute2 & \
    apt-get install -y ifupdown && \
    apt-get install -y iputils-ping && \
    echo resolvconf resolvconf/linkify-resolvconf boolean false | debconf-set-selections && \
    echo "REPORT_ABSENT_SYMLINK=no" >> /etc/default/resolvconf && \
    add-apt-repository --yes ppa:wireguard/wireguard && \
    apt-get install resolvconf

COPY scripts /scripts

ENTRYPOINT ["/scripts/run.sh"]
CMD []