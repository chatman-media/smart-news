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
  // Порт локальной веб-админки
  adminPort: Number(process.env.ADMIN_PORT || "8787"),
  // Куда бот шлёт черновики; если пусто — подставится id аккаунта из `bun run login`
  adminChatId: (process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null) as
    | number
    | null,
  // Используется только для первичного посева; дальше каналы живут в БД (админка)
  channelId: process.env.CHANNEL_ID || "",
  openrouterApiKey: required("OPENROUTER_API_KEY"),
  // Автопубликация без модерации; в личку приходит уведомление с кнопкой «убрать»
  autoPublish: process.env.AUTO_PUBLISH === "1",
  llmModel: process.env.LLM_MODEL || "anthropic/claude-opus-4.8",
  // Генерация иллюстраций, когда у поста нет пригодной картинки; пустая строка = выключено
  imageModel: process.env.IMAGE_MODEL ?? "google/gemini-3.1-flash-image",
  // Vision-модель для проверки «подходит ли картинка из источника к новости»
  visionModel: process.env.VISION_MODEL || "z-ai/glm-5v-turbo",
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
  // Для видео-постов (рилсов) хватает короткой подписи
  minVideoCaptionLength: 8,
  maxPostLength: 4000,
};

export function adminChatId(): number {
  if (config.adminChatId == null) {
    throw new Error("ADMIN_CHAT_ID не определён — он подставляется при старте из твоего аккаунта");
  }
  return config.adminChatId;
}
