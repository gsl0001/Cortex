// Telegram push for overnight runs: run-fail and needs-you events. Reuses the Claude
// Code telegram channel config (~/.claude/channels/telegram): TELEGRAM_BOT_TOKEN from
// .env plus the first allowlisted chat id. No config -> disabled, every push a no-op,
// so machines without the channel run exactly as before.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export function loadTelegramChannel(dir = join(homedir(), ".claude", "channels", "telegram")) {
  try {
    const env = readFileSync(join(dir, ".env"), "utf8");
    const token = env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m)?.[1]?.trim();
    const access = JSON.parse(readFileSync(join(dir, "access.json"), "utf8"));
    const chatId = (access.allowFrom || [])[0];
    return token && chatId ? { token, chatId: String(chatId) } : null;
  } catch {
    return null;
  }
}

// Debounced per key ("run-fail:<project>", "needs-you") so an overnight failure flood
// collapses to one message per key per window. sendImpl is injectable for tests; the
// default posts to the Bot API. push never throws — a Telegram outage must not touch
// the run pipeline.
export function createNotifier({
  channel = loadTelegramChannel(),
  sendImpl,
  minIntervalMs = Number(process.env.CORTEX_PUSH_MIN_INTERVAL_MS || 60_000),
  now = Date.now,
} = {}) {
  const lastSentByKey = new Map();
  const send = sendImpl || (async (text) => {
    await fetch(`https://api.telegram.org/bot${channel.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: channel.chatId, text }),
    });
  });
  const enabled = Boolean(channel || sendImpl);
  return {
    enabled,
    async push(key, text) {
      if (!enabled) return false;
      const t = now();
      const last = lastSentByKey.get(key);
      if (last !== undefined && t - last < minIntervalMs) return false;
      lastSentByKey.set(key, t);
      try {
        await send(text);
        return true;
      } catch {
        return false;
      }
    },
  };
}
