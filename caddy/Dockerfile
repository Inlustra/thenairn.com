FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/greenpau/caddy-security \
    --with github.com/greenpau/caddy-trace \
    --with github.com/caddy-dns/porkbun

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
