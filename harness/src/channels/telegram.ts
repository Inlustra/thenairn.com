// Telegram: Tom's line to Thor. Only his chat id is served; anyone else who
// finds the bot gets nothing at all.
import { Bot } from "grammy";
import { log } from "../log";

export function startTelegram(token: string, ownerChatId: string, onMessage: (text: string) => void) {
  const bot = new Bot(token);
  bot.on("message:text", (ctx) => {
    if (String(ctx.chat.id) !== ownerChatId) return void log.warn({ chat: ctx.chat.id }, "telegram message from non-owner ignored");
    onMessage(ctx.message.text);
  });
  bot.catch((e) => log.error({ err: String(e.error) }, "telegram error"));
  void bot.start({ drop_pending_updates: false });
  const send = async (text: string) => {
    for (let i = 0; i < text.length; i += 4000) await bot.api.sendMessage(ownerChatId, text.slice(i, i + 4000));
  };
  return { send, typing: () => bot.api.sendChatAction(ownerChatId, "typing").catch(() => {}) };
}
