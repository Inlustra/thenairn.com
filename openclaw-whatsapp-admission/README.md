# WhatsApp Concierge admission

This integration keeps OpenClaw's secure WhatsApp `pairing` gate while replacing its operator-facing code workflow with a simple conversation.

## User flow

1. An unknown sender messages the dedicated WhatsApp account.
2. Their message is quarantined; Concierge does not receive or process it.
3. The sender receives a friendly acknowledgement with no codes or commands.
4. Thomas receives a private WhatsApp notification naming the requester and replies `approve` or `deny`.
5. Milo recognises the trusted owner reply and hands its session/message references to Thor. Thor independently verifies the actual owner message and exact pending request before resolving it through the Gateway pairing API.
6. On approval, the sender receives a friendly confirmation and subsequent DMs route to an isolated Concierge session. Denial removes the pending request without admitting the sender.

Pairing references are deliberately not shown to Thomas. If several requests are pending and a reply does not clearly identify one, the owner agent asks which person rather than guessing.

## Components

- `index.ts` / `delivery.mjs`: listen for `channel_pairing_requested`, resolve the live isolated owner Concierge route, send the bounded owner notification, and mirror the exact delivered text and platform message ID into that same active session using the supported transcript SDK. No pairing code or quarantined message body is mirrored. A missing/wrong route or missing session fails closed before sending. A reset during delivery fences the mirror and logs an explicit reconciliation failure; it never silently reports both delivery and mirroring as complete.
- `notification.mjs`: validation and notification formatting shared with tests.
- `patch-installed-whatsapp.mjs`: version-sensitive patch for the managed `@openclaw/whatsapp` runtime package, adding friendly requester text and approval confirmation.
- `start-gateway.sh`: applies the patch before starting the Gateway. If the installed package no longer matches, it logs the mismatch and starts OpenClaw with its still-secure native pairing behavior.
- `/mnt/user/HQ/concierge/AGENTS.md` and operator role `roles/milo.md`: owner-only admission handoff, unchanged guest permissions and no new tools.
- `/mnt/user/HQ/sysadmin/AGENTS.md`: Thor independently verifies trusted owner provenance, notification correlation and current pending state before `channels.pairing.approve` / `channels.pairing.dismiss`. An expired or ambiguous request is never substituted with another pending request. Admission and welcome delivery are verified separately.

## Verification

```sh
node --test openclaw-whatsapp-admission/notification.test.mjs
node --test openclaw-whatsapp-admission/delivery.test.mjs
# In the Gateway container: actual runtime config/routing/SQLite, stub transport,
# isolated temporary state; sends no real WhatsApp message.
node --test openclaw-whatsapp-admission/session-integration.test.mjs
openclaw plugins inspect whatsapp-admission --runtime --json
openclaw gateway call channels.pairing.list \
  --params '{"channel":"whatsapp","accountId":"default"}' --json
openclaw channels status --probe --json
```

The pairing list should show `notifySupported: true`; the plugin should show `status: loaded` with the `channel_pairing_requested` hook; WhatsApp should be linked, connected, and healthy.

## Upgrade and rollback

2026-09-25 session fix: backups of the previous plugin entry point and both agent briefs, plus Milo's role, are under `/mnt/user/HQ/sysadmin/.setup-backup/admission-20260925/`. To undo only this fix, restore those versions (role policy through the supported `agent_policy` tool), remove the new delivery import/use, and reload the Gateway safely. Do not change channel bindings or guest admission state. No new guest was admitted while implementing this fix; the previous pending request was no longer present.

The patch targets the managed WhatsApp package bundled with OpenClaw 2026.9.4 and checks every replacement site. After an OpenClaw upgrade, inspect the startup log for `whatsapp-admission patches ready` and repeat the verification above.

To revert, remove the custom `command` from `docker-compose.openclaw.yml`, disable/remove `plugins.entries.whatsapp-admission` and its load path, then recreate only `openclaw-gateway` through the independent Compose helper. Native OpenClaw pairing remains the secure fallback.
