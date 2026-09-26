import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { buildPolicyBlock, normalizePolicyConfig, resolveFilesForAgent } from "./policy.mjs";
import {
  describeAssignments,
  listPolicyFiles,
  readPolicyFile,
  resolveRoot,
  writePolicyFile,
} from "./manage.mjs";

export default definePluginEntry({
  id: "agent-policy",
  name: "Shared Agent Policy",
  description:
    "Injects operator-owned shared and per-agent instruction files into every agent's system context.",
  register(api) {
    const readConfig = () => normalizePolicyConfig(api.pluginConfig);

    api.on(
      "before_prompt_build",
      async (_event, ctx) => {
        const config = readConfig();
        const agentId = typeof ctx?.agentId === "string" ? ctx.agentId : undefined;
        let block;
        try {
          block = await buildPolicyBlock(config, agentId);
        } catch (error) {
          api.logger.warn(`agent-policy: policy build failed: ${String(error)}`);
          return;
        }
        if (!block) return;

        if (block.problems.length > 0) {
          api.logger.warn(
            `agent-policy: degraded for ${agentId ?? "unknown agent"}: ${block.problems
              .map((problem) => `${problem.path} (${problem.status})`)
              .join(", ")}`,
          );
        }

        return { prependSystemContext: block.text };
      },
      { registrationId: "agent-policy.inject", timeoutMs: 5000 },
    );

    // Optional: only reaches agents that explicitly allowlist it, so a governed
    // agent cannot rewrite the policy that governs it.
    api.registerTool({
      name: "agent_policy",
      label: "Agent Policy",
      description:
        "Inspect and maintain the operator-owned shared agent policy library (list, read, write, assignments).",
      optional: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["action"],
        properties: {
          action: {
            type: "string",
            enum: ["list", "read", "write", "assignments"],
            description: "Operation to perform.",
          },
          file: {
            type: "string",
            description: "Policy file path relative to the policy root, for read and write.",
          },
          content: {
            type: "string",
            description: "Full replacement Markdown content for write.",
          },
        },
      },
      async execute(rawInput: unknown, ...rest: unknown[]) {
        // The host may hand params directly or wrapped; accept either shape.
        const candidates = [rawInput, ...rest].flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const record = value as Record<string, unknown>;
          return [record, record.args, record.params, record.input].filter(
            (entry): entry is Record<string, unknown> =>
              Boolean(entry) && typeof entry === "object",
          );
        });
        const input = (candidates.find(
          (entry) => typeof entry.action === "string",
        ) ?? {}) as { action?: string; file?: string; content?: string };

        if (!input.action) {
          throw new Error(
            `action is required; received keys: ${candidates
              .map((entry) => Object.keys(entry).join("|") || "<empty>")
              .join(" / ") || "<none>"}`,
          );
        }

        const config = readConfig();
        const root = resolveRoot(config);

        if (input.action === "list") {
          const files = await listPolicyFiles(root);
          return {
            content: [
              {
                type: "text",
                text: `Policy root: ${root}\n${files.length} file(s):\n${files
                  .map((file) => `- ${file}`)
                  .join("\n")}`,
              },
            ],
            details: { root, files },
          };
        }

        if (input.action === "assignments") {
          const agentIds = Object.keys(api.config?.agents?.entries ?? {});
          const assignments = describeAssignments(config, agentIds);
          return {
            content: [
              {
                type: "text",
                text: [
                  `Policy root: ${root}`,
                  `Defaults: ${config.defaults.join(", ") || "(none)"}`,
                  ...assignments.map(
                    (entry) => `${entry.agentId}: ${entry.files.join(", ") || "(defaults only)"}`,
                  ),
                ].join("\n"),
              },
            ],
            details: { root, defaults: config.defaults, assignments },
          };
        }

        if (!input.file) throw new Error("file is required for this action");

        if (input.action === "read") {
          const text = await readPolicyFile(root, input.file);
          return {
            content: [{ type: "text", text }],
            details: { root, file: input.file, content: text },
          };
        }

        const written = await writePolicyFile(
          root,
          input.file,
          input.content,
          config.maxFileChars,
        );
        api.logger.info(`agent-policy: updated ${written.path} (${written.chars} chars)`);
        return {
          content: [
            {
              type: "text",
              text: `Wrote ${written.path} (${written.chars} chars). Applies from the next turn.`,
            },
          ],
          details: { root, ...written, appliesFrom: "next turn" },
        };
      },
    });

    const config = readConfig();
    api.logger.info(
      `agent-policy: ${config.enabled ? "enabled" : "disabled"}; defaults=${
        config.defaults.length
      }; per-agent=${Object.keys(config.byAgent).length}`,
    );
    void resolveFilesForAgent;
  },
});
