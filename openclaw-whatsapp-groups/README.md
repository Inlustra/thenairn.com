# WhatsApp Groups

Gives an agent three tools: create a WhatsApp group, add people to one, and read
one back. Built so Milo can talk to someone and then bring them into a group
himself, instead of asking Thomas to do it by hand.

## Why this is a tool plugin and not a channel action

The obvious shape - a `group-create` *channel action* alongside `send` and
`react` - is not available, and deliberately so.
`src/channels/plugins/message-action-names.ts` upstream:

```
/**
 * Deliberately closed, core-owned vocabulary so every transport can render every action.
 * Plugins add names through a core PR; runtime registration is intentionally unsupported.
 */
```

There is no name for creating a group in that list at all (the create-verbs are
`thread-create`, `channel-create`, `category-create`, `topic-create`,
`event-create` - Discord- and Slack-shaped), and runtime registration is refused
by design. So a channel action would need an upstream PR.

Agent **tools** have no such restriction. `api.registerTool` registers at
runtime, so the capability arrives as a tool Milo can call rather than an action
the transport advertises.

## Why it borrows the Gateway's socket

WhatsApp permits one connection owner per account. Opening a second Baileys
socket with the same credentials does not get you a second connection, it fights
the Gateway for the only one (`WhatsAppConnectionOwnerBusyError`). So this reuses
the socket the Gateway already holds - the same one sends and reactions use:

```
createPluginRuntimeStore({ key: "plugin-runtime:whatsapp:channel-context-owner" })
  -> .tryGetRuntime()                     the WhatsApp channel runtime
  -> getChannelRuntimeContext(capability: "connection-controller")
  -> controller.getCurrentSock()          the live Baileys socket
```

Every step is public plugin-SDK surface (`openclaw/plugin-sdk/runtime-store`,
`openclaw/plugin-sdk/channel-runtime-context`). Nothing here imports the
installed `@openclaw/whatsapp` dist.

**That is the point.** The sibling `openclaw-whatsapp-admission` plugin patches
that package with a guarded regex against a minified bundle, and has to be
re-checked on every upgrade. This does not, so an upstream rebuild of the
WhatsApp package cannot silently break it. The one thing it does depend on is
the runtime-store *key* above, which is why the key is named in one place with
this comment attached.

## The failure mode that matters

**A direct add usually fails, and it fails quietly.** Most people's WhatsApp
privacy settings do not allow being added to a group by a stranger. The API
returns per-participant statuses rather than throwing, so code that only checks
"did the call resolve" reports success while the person was never added.

Handled explicitly: `403` is surfaced as `privacy-settings`, and the tools fetch
a group invite link **only** when at least one participant hit it, so the agent
has something to send instead. Other statuses are mapped too - `408` not on
WhatsApp, `409` already a member, `401` blocked.

The invite link is not returned by default. Anyone holding it can join, so it is
fetched only when it is actually needed.

## Tools

| Tool | Does |
|---|---|
| `whatsapp_group_create` | Create a group with a subject and optional members. Returns the group id. |
| `whatsapp_group_add` | Add people to an existing group. |
| `whatsapp_group_info` | Read a group's subject and members. |

Numbers may be given in international format (`+44 7700 900123`) or as a full
WhatsApp address; both normalize to a user JID. `maxParticipants` (default 32)
caps one call as a guard against a mistaken bulk add - it is not a WhatsApp
limit.

## Granting it

The tools are `optional: true`, so no agent gets them implicitly. Grant per agent
under that agent's `tools.allow`. Milo (`concierge`) has a strict allowlist, so
his grant is explicit and auditable:

```json
"concierge": { "tools": { "allow": [
  "ask_user", "sessions_send", "automations",
  "whatsapp_group_create", "whatsapp_group_add", "whatsapp_group_info"
] } }
```

## Account resolution

With no `channels.whatsapp.accounts` block the controller registers under an
implicit default id, and the runtime-context registry exposes `register/get/watch`
but **no list**, so a plugin cannot read back which spelling was used. The
resolver tries the plausible ids in order and, on failure, names every id it
tried rather than asserting one. An explicitly requested account never falls back
to a different one.

## Verified

- 2026-09-24 - plugin loads, all three tools register, `status: loaded`.
- 2026-09-24 - read path proven against the live socket: `whatsapp_group_info`
  on a non-existent group returns the Baileys protocol error
  `Invalid group metadata response: missing <group> node`, which is only
  reachable by actually querying WhatsApp.
- Not yet live-tested: `whatsapp_group_create` and `whatsapp_group_add`. Both
  create real, visible artifacts, so they want a deliberate test rather than a
  drive-by one.
