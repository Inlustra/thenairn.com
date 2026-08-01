FROM caddy:2.11.4-builder AS builder

RUN GOTOOLCHAIN=go1.25.8 xcaddy build \
    --with github.com/greenpau/caddy-security \
    --with github.com/greenpau/caddy-trace \
    --with github.com/caddy-dns/porkbun

FROM caddy:2.11.4

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
