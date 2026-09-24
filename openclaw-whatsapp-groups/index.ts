import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  describeParticipantResults,
  needsInviteLink,
  normalizeConfig,
  prepareParticipants,
  resolveSocket,
  toGroupJid,
} from "./groups.mjs";

/** The host may hand params directly or wrapped; accept either shape. */
function readInput(rawInput: unknown, ...rest: unknown[]): Record<string, unknown> {
  const candidates = [rawInput, ...rest].flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return [record, record.args, record.params, record.input].filter(
      (entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object",
    );
  });
  return (candidates.find((e) => "subject" in e || "groupJid" in e) ?? candidates[0] ?? {}) as Record<
    string,
    unknown
  >;
}

const accountIdParam = {
  type: "string",
  description: "WhatsApp account id. Omit for the default account.",
};

export default definePluginEntry({
  id: "whatsapp-groups",
  name: "WhatsApp Groups",
  description:
    "Create WhatsApp groups and manage their members using the Gateway's existing connection.",
  register(api) {
    const cfg = () => normalizeConfig(api.pluginConfig);

    /** Invite links are only fetched when a direct add was actually refused. */
    const inviteLinkIfNeeded = async (sock: any, groupJid: string, failed: unknown[]) => {
      if (!needsInviteLink(failed as never)) return undefined;
      try {
        const code = await sock.groupInviteCode(groupJid);
        return code ? `https://chat.whatsapp.com/${code}` : undefined;
      } catch (error) {
        api.logger.warn(
          `whatsapp-groups: could not fetch invite code for ${groupJid}: ${String(error)}`,
        );
        return undefined;
      }
    };

    const summarize = (added: any[], failed: any[], inviteLink?: string) => {
      const lines = [`Added ${added.length}.`];
      if (failed.length) {
        lines.push(
          `Not added (${failed.length}):`,
          ...failed.map((f) => `- ${f.jid}: ${f.detail}`),
        );
      }
      if (inviteLink) lines.push(`Invite link to send them: ${inviteLink}`);
      return lines.join("\n");
    };

    api.registerTool({
      name: "whatsapp_group_create",
      label: "Create WhatsApp group",
      optional: true,
      description:
        "Create a WhatsApp group with a subject and optional starting participants. Returns the " +
        "group id, needed for every later operation on it. Anyone whose privacy settings block " +
        "being added directly is reported back with an invite link to send them instead.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["subject"],
        properties: {
          subject: {
            type: "string",
            minLength: 1,
            maxLength: 100,
            description: "The group name, as members will see it.",
          },
          participants: {
            type: "array",
            items: { type: "string" },
            description:
              "Phone numbers in international format, or WhatsApp user addresses. This account " +
              "is always a member and must not be listed.",
          },
          accountId: accountIdParam,
        },
      },
      execute: async (_toolCallId: string, rawInput: unknown, ...rest: unknown[]) => {
        const input = readInput(rawInput, ...rest);
        const subject = String(input.subject ?? "").trim();
        if (!subject) throw new Error("subject is required");

        const config = cfg();
        const sock = resolveSocket(input.accountId ?? config.defaultAccountId);
        const jids = prepareParticipants(input.participants, config.maxParticipants);

        const metadata = await sock.groupCreate(subject, jids);
        const groupJid = metadata?.id;
        if (!groupJid) throw new Error("group creation returned no group id");

        const { added, failed } = describeParticipantResults(metadata?.participants);
        const inviteLink = await inviteLinkIfNeeded(sock, groupJid, failed);

        api.logger.info(
          `whatsapp-groups: created "${subject}" (${groupJid}); added ${added.length}, refused ${failed.length}`,
        );
        return {
          content: [
            { type: "text", text: `Created "${subject}".\n${summarize(added, failed, inviteLink)}` },
          ],
          details: { groupJid, subject, added, failed, inviteLink },
        };
      },
    });

    api.registerTool({
      name: "whatsapp_group_add",
      label: "Add people to a WhatsApp group",
      optional: true,
      description:
        "Add one or more people to an existing WhatsApp group. Use this after talking to someone " +
        "to bring them into a group that already exists. Anyone whose privacy settings block a " +
        "direct add is reported back with an invite link to send them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["groupJid", "participants"],
        properties: {
          groupJid: {
            type: "string",
            description: "The group id returned when the group was created.",
          },
          participants: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            description: "Phone numbers in international format, or WhatsApp user addresses.",
          },
          accountId: accountIdParam,
        },
      },
      execute: async (_toolCallId: string, rawInput: unknown, ...rest: unknown[]) => {
        const input = readInput(rawInput, ...rest);
        const config = cfg();
        const sock = resolveSocket(input.accountId ?? config.defaultAccountId);
        const groupJid = toGroupJid(input.groupJid);
        const jids = prepareParticipants(input.participants, config.maxParticipants);
        if (!jids.length) throw new Error("participants is required");

        const results = await sock.groupParticipantsUpdate(groupJid, jids, "add");
        const { added, failed } = describeParticipantResults(results);
        const inviteLink = await inviteLinkIfNeeded(sock, groupJid, failed);

        api.logger.info(
          `whatsapp-groups: added ${added.length} to ${groupJid}, refused ${failed.length}`,
        );
        return {
          content: [{ type: "text", text: summarize(added, failed, inviteLink) }],
          details: { groupJid, added, failed, inviteLink },
        };
      },
    });

    api.registerTool({
      name: "whatsapp_group_info",
      label: "Read a WhatsApp group",
      optional: true,
      description:
        "Read a group's subject and members. Use this to confirm a group exists and who is in it " +
        "before talking about it or adding someone.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["groupJid"],
        properties: { groupJid: { type: "string" }, accountId: accountIdParam },
      },
      execute: async (_toolCallId: string, rawInput: unknown, ...rest: unknown[]) => {
        const input = readInput(rawInput, ...rest);
        const config = cfg();
        const sock = resolveSocket(input.accountId ?? config.defaultAccountId);
        const groupJid = toGroupJid(input.groupJid);
        const meta = await sock.groupMetadata(groupJid);
        const members = (meta?.participants ?? []).map((p: any) => ({
          jid: p?.id,
          admin: p?.admin ?? null,
        }));
        return {
          content: [
            {
              type: "text",
              text: `"${meta?.subject ?? "(no subject)"}" - ${members.length} member(s).`,
            },
          ],
          details: { groupJid, subject: meta?.subject, memberCount: members.length, members },
        };
      },
    });
  },
});
