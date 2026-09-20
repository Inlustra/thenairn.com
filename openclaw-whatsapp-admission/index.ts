import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { formatOwnerPairingAlert, normalizeAdmissionConfig } from "./notification.mjs";

export default definePluginEntry({
  id: "whatsapp-admission",
  name: "WhatsApp Concierge Admission",
  description: "Notifies the owner about quarantined WhatsApp guest pairing requests.",
  register(api) {
    const config = normalizeAdmissionConfig(api.pluginConfig);

    api.on(
      "channel_pairing_requested",
      async (event) => {
        if (event.channel !== "whatsapp") return;
        if ((event.accountId || "default") !== config.accountId) return;

        const adapter = await api.runtime.channel.outbound.loadAdapter("whatsapp");
        const send = adapter?.sendText;
        if (!send) {
          api.logger.warn("whatsapp-admission: WhatsApp outbound adapter unavailable");
          return;
        }

        await send({
          cfg: api.config,
          to: config.ownerNumber,
          text: formatOwnerPairingAlert(event),
          accountId: config.accountId,
        });
        api.logger.info("whatsapp-admission: owner notification delivered");
      },
      {
        registrationId: "whatsapp-admission.owner-notification",
        timeoutMs: 1900,
      },
    );
  },
});
