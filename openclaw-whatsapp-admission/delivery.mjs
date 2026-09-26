import { createHash } from "node:crypto";
import { formatOwnerPairingAlert } from "./notification.mjs";

// Keep transport delivery and its conversation mirror together. Dependencies are
// public SDK functions supplied by the entry point, so tests never send a DM.
export async function deliverOwnerAlert({ api, config, event, getSessionEntry, appendMirror }) {
  if (event.channel !== "whatsapp" || (event.accountId || "default") !== config.accountId) return;
  const cfg = api.runtime.config.current();
  const route = api.runtime.channel.routing.resolveAgentRoute({
    cfg, channel: "whatsapp", accountId: config.accountId,
    peer: { kind: "direct", id: config.ownerNumber },
  });
  // Never mirror an owner alert into a shared/main or another person's session.
  const expectedKey = `agent:concierge:whatsapp:${config.accountId}:direct:${config.ownerNumber}`;
  if (route.agentId !== "concierge" || route.sessionKey !== expectedKey) {
    throw new Error("Owner admission route is not the isolated Concierge DM; operator review required");
  }
  const scope = {
    agentId: route.agentId, sessionKey: route.sessionKey,
    storePath: api.runtime.channel.session.resolveStorePath(cfg.session?.store, { agentId: route.agentId }),
  };
  const entry = getSessionEntry(scope);
  if (!entry?.sessionId) throw new Error("Owner Concierge conversation must exist before admission alerts can be sent");
  const adapter = await api.runtime.channel.outbound.loadAdapter("whatsapp");
  if (!adapter?.sendText) throw new Error("WhatsApp outbound adapter unavailable");
  const text = formatOwnerPairingAlert(event);
  const sent = await adapter.sendText({ cfg, to: config.ownerNumber, text, accountId: config.accountId });
  const sourceMessageId = sent?.messageId;
  if (!sourceMessageId) throw new Error("Admission alert sent but transport receipt has no message ID; reconcile before resending");
  const idempotencyKey = "whatsapp-admission:" + createHash("sha256")
    .update(JSON.stringify([config.accountId, config.ownerNumber, sourceMessageId])).digest("hex");
  const mirrored = await appendMirror({
    ...scope, config: cfg, sessionId: entry.sessionId, text, idempotencyKey,
    deliveryMirror: { kind: "channel-final", sourceMessageId },
  });
  if (!mirrored.ok) throw new Error(`Admission alert delivered but conversation mirror failed (${mirrored.code || "blocked"}); reconcile before resending`);
  api.logger.info("whatsapp-admission: owner notification delivered and mirrored");
  return { sourceMessageId, messageId: mirrored.messageId, sessionKey: route.sessionKey };
}
