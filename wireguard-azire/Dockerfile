FROM ubuntu:16.04

# Thanks to https://nbsoftsolutions.com/blog/routing-select-docker-containers-through-wireguard-vpn
RUN apt-get update -y

# Supposed workaround for dpkg issue... https://gist.github.com/Francesco149/ce376cd83d42774ed39d34816b9e21db
RUN echo N | sudo tee /sys/module/overlay/parameters/metacopy 

RUN apt-get install -y software-properties-common iptables curl iproute2 ifupdown iputils-ping
RUN echo resolvconf resolvconf/linkify-resolvconf boolean false | debconf-set-selections && \
    echo "REPORT_ABSENT_SYMLINK=no" >> /etc/default/resolvconf
RUN add-apt-repository --yes ppa:wireguard/wireguard && \
    apt-get install resolvconf

COPY scripts /scripts

ENTRYPOINT ["/scripts/run.sh"]
CMD []