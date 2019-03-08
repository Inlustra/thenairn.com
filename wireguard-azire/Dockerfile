FROM ubuntu:16.04

# Thanks to https://nbsoftsolutions.com/blog/routing-select-docker-containers-through-wireguard-vpn
RUN apt-get update -y
RUN apt-get install -y jq
RUN apt-get install -y gettext-base
RUN apt-get install -y software-properties-common 
RUN apt-get install -y iptables
RUN apt-get install -y curl
RUN apt-get install -y iproute2 
RUN apt-get install -y ifupdown 
RUN apt-get install -y iputils-ping 
RUN echo resolvconf resolvconf/linkify-resolvconf boolean false | debconf-set-selections && \
    echo "REPORT_ABSENT_SYMLINK=no" >> /etc/default/resolvconf
RUN add-apt-repository --yes ppa:wireguard/wireguard && \
    apt-get install resolvconf

COPY scripts /scripts

ENTRYPOINT ["/scripts/run.sh"]
CMD []