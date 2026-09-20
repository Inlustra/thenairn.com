function cleanSingleLine(value, maxLength = 80) {
  if (typeof value !== "string") return "";
  return value.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function formatOwnerPairingAlert(event) {
  const senderId = cleanSingleLine(event?.senderId, 40) || "unknown number";
  const suppliedName = cleanSingleLine(event?.metadata?.name, 80);
  const from = suppliedName
    ? `${suppliedName} (${senderId}) — WhatsApp name, unverified`
    : senderId;
  return [
    "🛎️ New WhatsApp Concierge request",
    `From: ${from}`,
    "",
    "Reply “approve” or “deny”. I’ll handle the rest.",
    "Their message has not been shared with or processed by Concierge.",
  ].join("\n");
}

export function normalizeAdmissionConfig(raw) {
  const value = raw && typeof raw === "object" ? raw : {};
  const ownerNumber = cleanSingleLine(value.ownerNumber, 24);
  const accountId = cleanSingleLine(value.accountId, 64) || "default";
  if (!/^\+[1-9][0-9]{6,14}$/.test(ownerNumber)) {
    throw new Error("whatsapp-admission requires ownerNumber in E.164 format");
  }
  return { ownerNumber, accountId };
}
