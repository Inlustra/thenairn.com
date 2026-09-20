# WhatsApp Concierge admission

This integration keeps OpenClaw's secure WhatsApp `pairing` gate while replacing its operator-facing code workflow with a simple conversation.

## User flow

1. An unknown sender messages the dedicated WhatsApp account.
2. Their message is quarantined; Concierge does not receive or process it.
3. The sender receives a friendly acknowledgement with no codes or commands.
4. Thomas receives a private WhatsApp notification naming the requester and replies `approve` or `deny`.
5. The main owner agent resolves the pending request through the Gateway pairing API.
6. On approval, the sender receives a friendly confirmation and subsequent DMs route to an isolated Concierge session. Denial removes the pending request without admitting the sender.

Pairing references are deliberately not shown to Thomas. If several requests are pending and a reply does not clearly identify one, the owner agent asks which person rather than guessing.

## Components

- `index.ts`: listens for `channel_pairing_requested` and sends the bounded owner notification. It never includes the quarantined message body.
- `notification.mjs`: validation and notification formatting shared with tests.
- `patch-installed-whatsapp.mjs`: version-sensitive patch for the managed `@openclaw/whatsapp` runtime package, adding friendly requester text and approval confirmation.
- `start-gateway.sh`: applies the patch before starting the Gateway. If the installed package no longer matches, it logs the mismatch and starts OpenClaw with its still-secure native pairing behavior.
- `/home/node/.openclaw/workspace/AGENTS.md`: tells the full-power owner agent how to translate Thomas's natural-language decision into `channels.pairing.approve` or `channels.pairing.dismiss`.

## Verification

```sh
node --test openclaw-whatsapp-admission/notification.test.mjs
openclaw plugins inspect whatsapp-admission --runtime --json
openclaw gateway call channels.pairing.list \
  --params '{"channel":"whatsapp","accountId":"default"}' --json
openclaw channels status --probe --json
```

The pairing list should show `notifySupported: true`; the plugin should show `status: loaded` with the `channel_pairing_requested` hook; WhatsApp should be linked, connected, and healthy.

## Upgrade and rollback

The patch targets the managed WhatsApp package bundled with OpenClaw 2026.9.4 and checks every replacement site. After an OpenClaw upgrade, inspect the startup log for `whatsapp-admission patches ready` and repeat the verification above.

To revert, remove the custom `command` from `docker-compose.openclaw.yml`, disable/remove `plugins.entries.whatsapp-admission` and its load path, then recreate only `openclaw-gateway` through the independent Compose helper. Native OpenClaw pairing remains the secure fallback.
