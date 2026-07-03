// Источники и каналы теперь живут в БД; sources.json используется один раз как посев.
import { config } from "./config";
import {
  addChannelSource,
  type Channel,
  type ChannelSource,
  channelsCount,
  createChannel,
  listChannelSources,
} from "./db";

interface SeedFile {
  region?: string;
  channels?: { username: string; note?: string }[];
  feeds?: { name: string; url: string; note?: string }[];
}

/** Первый запуск после апгрейда: создаёт канал из .env и переносит sources.json в БД. */
export async function seedChannelsIfEmpty(): Promise<void> {
  if (channelsCount() > 0) return;
  if (!config.channelId) {
    throw new Error("Каналы не настроены: задай CHANNEL_ID в .env или создай канал в админке");
  }
  const channel = createChannel({
    name: "Основной",
    chat_id: String(config.channelId),
    focus: "русскоязычные экспаты на Пхукете и в Таиланде",
    negative_quota: config.negativeQuotaPct,
    auto_publish: config.autoPublish ? 1 : 0,
    rubric_hour: config.rubricHour,
    rubrics_enabled: 1,
    active: 1,
  });

  try {
    const seed = (await Bun.file("sources.json").json()) as SeedFile;
    for (const c of seed.channels ?? []) {
      addChannelSource(channel.id, "telegram", c.username, c.username, c.note ?? "");
    }
    for (const f of seed.feeds ?? []) {
      addChannelSource(channel.id, "rss", f.url, f.name, f.note ?? "");
    }
    console.log(`Посев: канал «${channel.name}» (${channel.chat_id}) + источники из sources.json`);
  } catch {
    console.log(`Посев: канал «${channel.name}» без источников (sources.json не найден)`);
  }
}

export function telegramSources(channel: Channel): ChannelSource[] {
  return listChannelSources(channel.id, true).filter((s) => s.kind === "telegram");
}

export function rssSources(channel: Channel): ChannelSource[] {
  return listChannelSources(channel.id, true).filter((s) => s.kind === "rss");
}
