function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Не задана переменная окружения ${name} — скопируй .env.example в .env и заполни`,
    );
  }
  return value;
}

export const config = {
  tgApiId: Number(required("TG_API_ID")),
  tgApiHash: required("TG_API_HASH"),
  botToken: required("BOT_TOKEN"),
  adminChatId: Number(required("ADMIN_CHAT_ID")),
  channelId: parseChatId(required("CHANNEL_ID")),
  openrouterApiKey: required("OPENROUTER_API_KEY"),
  llmModel: process.env.LLM_MODEL || "anthropic/claude-opus-4.8",
  pollIntervalMin: Number(process.env.POLL_INTERVAL_MIN || "10"),
  // Максимальная доля негатива в фиде, % (важность 5 — предупреждения о безопасности — проходят всегда)
  negativeQuotaPct: Number(process.env.NEGATIVE_QUOTA_PCT || "20"),
  // Час (локальное время сервера), после которого генерируется ежедневная рубрика
  rubricHour: Number(process.env.RUBRIC_HOUR || "10"),
  // На первом запуске берём только хвост канала, чтобы не сжечь токены на архиве
  firstRunLimit: 10,
  perCycleLimit: 50,
  rssFirstRunLimit: 5,
  rssPerCycleLimit: 20,
  minPostLength: 40,
  maxPostLength: 4000,
};

function parseChatId(raw: string): string | number {
  return raw.startsWith("@") ? raw : Number(raw);
}
