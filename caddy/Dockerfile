FROM caddy:2-builder AS builder

RUN xcaddy build \
    --with github.com/greenpau/caddy-auth-jwt \
    --with github.com/greenpau/caddy-auth-portal \
    --with github.com/caddy-dns/gandi

FROM caddy:2

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
