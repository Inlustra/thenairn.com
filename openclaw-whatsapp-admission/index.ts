import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendAssistantMirrorMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { normalizeAdmissionConfig } from "./notification.mjs";
import { deliverOwnerAlert } from "./delivery.mjs";

export default definePluginEntry({
  id: "whatsapp-admission",
  name: "WhatsApp Concierge Admission",
  description: "Notifies the owner about quarantined WhatsApp guest pairing requests.",
  register(api) {
    const config = normalizeAdmissionConfig(api.pluginConfig);
    api.logger.info("whatsapp-admission: session-aware owner notification hook registered (2026-09-25)");

    api.on(
      "channel_pairing_requested",
      async (event) => {
        await deliverOwnerAlert({ api, config, event, getSessionEntry,
          appendMirror: appendAssistantMirrorMessageByIdentity });
      },
      {
        registrationId: "whatsapp-admission.owner-notification",
        timeoutMs: 10000,
      },
    );
  },
});
