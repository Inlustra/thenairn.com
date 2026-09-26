# OpenClaw 2026.9.4 owner-authority repair

The Gateway RPC user-turn preparation derived owner status from admin transport
even for `inter_session` input. Transcript persistence independently marked such
input non-owner. The result was different executable authority and visible provenance.

This narrowly version/hash-pinned repair makes inter-session turns non-owner and
requires literal `true` at the conversation-tool guard. It grants no new tools,
does not change guest permissions, and preserves ordinary owner and trusted cron
continuation behavior. It is not an upstream release or general upgrade.

Run `node --test openclaw-authority-fix/authority.test.mjs` and
`node openclaw-authority-fix/patch.mjs` to test/check without changing runtime.
`--apply` validates both original hashes and backup contents before writing.
Reapplication is hash-verified and idempotent. Existing admission startup wrapper
applies it before loading OpenClaw and fails closed on version/hash mismatch.

The writes are not filesystem-transactional; never restart after a failed apply.
After application run the tests and a second check (changed must be zero), then
use the supported safe Gateway restart. No whole-stack recreation is needed.

Recovery: retain original runtime files as `*.before-milo-authority-fix`; restore
both if deployment verification fails, revert only the new startup-wrapper block,
and use a supported Gateway restart. Concierge conversation tools remain disabled
until live negative tests pass. When upgrading, review/remove this version pin
against the new upstream implementation before restarting.

Welcomes use an explicitly owner-authorized, Milo/concierge-owned one-shot run
with exact approved text and a validated recipient route. Scheduling is not
delivery: retain required-delivery receipts, do not resend ambiguous results,
and never give an inter-session handoff implicit owner authority.
