# OpenClaw native authentication bridge

A narrow WebSocket admission bridge for native OpenClaw clients that cannot complete the browser-only Google OAuth flow. It validates the dedicated token in the first `connect` request and forwards that request **byte-for-byte unchanged**, because OpenClaw's device signature binds both the Gateway challenge and `auth.token`. The upstream Gateway authorizes the connection from trusted-proxy headers.

## Security boundary

- Runs in Caddy's network namespace and binds only `127.0.0.1:18791`. Do not publish this port.
- Accepts WebSocket upgrades only from loopback, for the configured host/path, with one syntactically valid `X-Forwarded-For` address.
- Reads the token only from a Docker secret file, compares SHA-256 digests with `timingSafeEqual`, and never logs frames or credentials.
- Pins `ws` and the Node image. Compression and redirects are disabled.
- Relays only a valid, bounded upstream `connect.challenge`, then accepts one bounded text `connect` request before raising the pinned `ws` receiver's payload ceiling.
- Rejects duplicate JSON keys during admission and rate-limits failed attempts by client address and globally; after admission it never parses application frames and relays data and control frames transparently.

## Required Caddy route (deployment only; not applied here)

Caddy must overwrite attribution rather than accepting inbound forwarding headers:

```caddyfile
claw-native.thenairn.com {
    reverse_proxy 127.0.0.1:18791 {
        header_up Host claw-native.thenairn.com
        header_up X-Forwarded-Host claw-native.thenairn.com
        header_up X-Forwarded-Proto https
        header_up X-Forwarded-For {http.request.remote.host}
        header_up -X-Forwarded-User
    }
}
```

Do **not** import the Google OAuth policy on this hostname. The bridge supplies `X-Forwarded-User` only on its separate upstream socket after token validation. Keep `claw.thenairn.com` unchanged.

## Secret and configuration

Set `OPENCLAW_NATIVE_BRIDGE_TOKEN_FILE` to an absolute host path containing a newly generated random token (at least 32 characters, one optional trailing newline). Make it readable only by container uid/gid 1000 (for example, `install -o 1000 -g 1000 -m 0400 source-token "$OPENCLAW_NATIVE_BRIDGE_TOKEN_FILE"`). Compose mounts it read-only as `/run/secrets/openclaw_native_bridge_token`; the token itself is never placed in Compose or environment variables. Compose file-backed secrets retain host-file ownership on this deployment, so the ownership step is required.

Important defaults are declared explicitly in `docker-compose.openclaw.yml`. The bridge and Caddy must be recreated together because `network_mode: service:caddy` joins Caddy's network namespace.

## Verification

```sh
cd openclaw-native-auth-bridge
npm ci
npm run lint
npm test
cd ..
docker build -t openclaw-native-auth-bridge:test openclaw-native-auth-bridge
docker compose --env-file .env -f docker-compose.yml -f docker-compose.openclaw.yml config
```
