// WhatsApp group operations against the Gateway's own live Baileys socket.
//
// Why this reaches for a runtime store rather than importing @openclaw/whatsapp:
// WhatsApp permits exactly one connection owner per account. Opening a second
// socket with the same credentials does not give us a second connection, it
// fights the Gateway for the only one (WhatsAppConnectionOwnerBusyError). So we
// borrow the socket the Gateway already holds - the same one reactions and sends
// already use - through two public plugin-SDK subpaths and a documented key.
//
// Every import below is public SDK surface. Nothing here reads the installed
// @openclaw/whatsapp dist, so an upstream rebuild of that package cannot break
// this the way a text patch against a minified bundle would.

import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { getChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";

// The key @openclaw/whatsapp itself uses in extensions/whatsapp/src/runtime.ts.
// createPluginRuntimeStore stores *named* slots (option object, not bare string)
// on globalThis precisely so duplicate SDK module instances share one runtime,
// which is what lets a separate plugin read the channel runtime the extension set.
const WHATSAPP_CHANNEL_RUNTIME_KEY = "plugin-runtime:whatsapp:channel-context-owner";
const CONNECTION_CONTROLLER_CAPABILITY = "connection-controller";

const channelRuntimeStore = createPluginRuntimeStore({
  key: WHATSAPP_CHANNEL_RUNTIME_KEY,
  errorMessage: "WhatsApp channel runtime not initialized",
});

/** Per-participant status codes returned by groupParticipantsUpdate/groupCreate. */
const PARTICIPANT_STATUS = {
  "200": { ok: true, reason: "added" },
  "403": {
    ok: false,
    reason: "privacy-settings",
    // The single most common real outcome, and the one that silently looks like
    // success if you only check that the call resolved.
    detail: "their privacy settings do not allow being added directly; send the invite link instead",
  },
  "408": { ok: false, reason: "not-on-whatsapp", detail: "that number is not on WhatsApp" },
  "409": { ok: false, reason: "already-member", detail: "already in the group" },
  "401": { ok: false, reason: "blocked", detail: "they have blocked this account" },
};

/**
 * Resolve the Gateway's live socket, or explain why we cannot.
 *
 * The controller is registered under whatever account id the channel resolved at
 * startup. With no `channels.whatsapp.accounts` block that is an implicit default,
 * and the exact spelling is not something a plugin can read back - the runtime
 * context registry exposes register/get/watch but no list. So try the plausible
 * ids in order and, on failure, say which were tried rather than asserting one.
 */
export function resolveSocket(accountId) {
  const channelRuntime = channelRuntimeStore.tryGetRuntime();
  if (!channelRuntime) {
    throw new Error(
      "WhatsApp channel runtime is not initialized. The WhatsApp channel must be enabled and " +
        "started before group tools can run.",
    );
  }

  // An agent may pass "" for "unset"; that is not the same as the default account.
  const explicit = typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
  const candidates = [];
  for (const candidate of [explicit, "default", undefined, ""]) {
    if (!candidates.some((seen) => seen === candidate)) candidates.push(candidate);
    if (explicit) break; // An explicitly named account must not silently fall back to another.
  }

  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate === undefined ? "<unset>" : `"${candidate}"`);
    const controller = getChannelRuntimeContext({
      channelRuntime,
      channelId: "whatsapp",
      accountId: candidate,
      capability: CONNECTION_CONTROLLER_CAPABILITY,
    });
    if (!controller || typeof controller.getCurrentSock !== "function") continue;
    const sock = controller.getCurrentSock();
    if (sock) return sock;
    // Controller present but no socket: the account is real and currently down.
    // That is a transient state worth reporting differently from a wrong id, so
    // the caller waits rather than reconfiguring something already correct.
    throw new Error(
      `WhatsApp account ${tried[tried.length - 1]} is not currently connected. ` +
        "Wait for it to reconnect and try again.",
    );
  }

  throw new Error(
    `No WhatsApp connection controller found (tried account ${tried.join(", ")}). ` +
      "The channel may not be configured, or may still be connecting.",
  );
}

/**
 * Normalize a phone number or JID to a WhatsApp user JID.
 * Accepts "+44 7700 900123", "447700900123", or an already-formed JID.
 */
export function toUserJid(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("empty participant");
  if (raw.endsWith("@s.whatsapp.net")) return raw;
  if (raw.endsWith("@g.us")) throw new Error(`"${raw}" is a group, not a person`);
  if (raw.includes("@")) throw new Error(`"${raw}" is not a WhatsApp user address`);
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length < 7 || digits.length > 15) {
    // E.164 allows at most 15 digits; below 7 is never a routable mobile number.
    throw new Error(`"${raw}" is not a usable phone number`);
  }
  return `${digits}@s.whatsapp.net`;
}

/** Normalize a group JID, accepting a bare id or a full address. */
export function toGroupJid(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new Error("empty group id");
  if (raw.endsWith("@g.us")) return raw;
  if (raw.includes("@")) throw new Error(`"${raw}" is not a group address`);
  return `${raw}@g.us`;
}

/** Turn raw per-participant results into something an agent can act on. */
export function describeParticipantResults(results) {
  const added = [];
  const failed = [];
  for (const entry of results ?? []) {
    const jid = entry?.jid ?? entry?.id;
    const status = String(entry?.status ?? entry?.content?.attrs?.error ?? "");
    const known = PARTICIPANT_STATUS[status];
    if (known?.ok) {
      added.push({ jid });
      continue;
    }
    failed.push({
      jid,
      status: status || "unknown",
      reason: known?.reason ?? "unknown",
      detail: known?.detail ?? "could not be added",
    });
  }
  return { added, failed };
}

/** True when any failure is one an invite link would solve. */
export function needsInviteLink(failed) {
  return (failed ?? []).some((f) => f.reason === "privacy-settings");
}

export function normalizeConfig(config) {
  const maxParticipants = Number(config?.maxParticipants ?? 32);
  return {
    defaultAccountId: config?.defaultAccountId || undefined,
    maxParticipants: Number.isFinite(maxParticipants)
      ? Math.min(Math.max(maxParticipants, 1), 256)
      : 32,
  };
}

/** Validate and normalize a participant list in one place. */
export function prepareParticipants(participants, max) {
  const list = Array.isArray(participants) ? participants : [];
  const jids = [...new Set(list.map(toUserJid))];
  if (jids.length > max) {
    throw new Error(`too many participants: ${jids.length} (limit ${max})`);
  }
  return jids;
}
