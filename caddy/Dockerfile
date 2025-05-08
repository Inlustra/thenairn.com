FROM caddy:2.9.1-builder AS builder

RUN GOTOOLCHAIN=go1.24.1 xcaddy build \
    --with github.com/greenpau/caddy-security \
    --with github.com/greenpau/caddy-trace \
    --with github.com/caddy-dns/porkbun

FROM caddy:2.9.1

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
