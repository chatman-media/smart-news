// Обратная связь по каналам: раз в день читаем просмотры/реакции постов через MTProto
// и превращаем их в подсказку классификатору (какие категории заходят аудитории).
import type { TelegramClient } from "@mtcute/bun";
import {
  type Channel,
  engagementByCategory,
  kvGet,
  kvSet,
  listChannels,
  publishedForEngagement,
  updateEngagement,
} from "./db";

const MIN_VIEWS_FOR_HINT = 50;

async function collectChannelEngagement(tg: TelegramClient, channel: Channel): Promise<number> {
  const drafts = publishedForEngagement(channel.id, 14);
  if (drafts.length === 0) return 0;
  const byMsgId = new Map(drafts.map((d) => [d.channel_msg_id, d.id]));

  const peer = channel.chat_id.startsWith("@")
    ? channel.chat_id.replace("@", "")
    : Number(channel.chat_id);

  let updated = 0;
  for await (const msg of tg.iterHistory(peer, { limit: 100 })) {
    const draftId = byMsgId.get(msg.id);
    if (!draftId) continue;
    const reactions = (msg.reactions?.reactions ?? []).reduce((sum, r) => sum + (r.count ?? 0), 0);
    updateEngagement(draftId, msg.views ?? 0, msg.forwards ?? 0, reactions);
    updated++;
  }

  refreshHint(channel);
  return updated;
}

export async function collectEngagement(tg: TelegramClient): Promise<number> {
  let updated = 0;
  for (const channel of listChannels(true)) {
    updated += await collectChannelEngagement(tg, channel).catch((err) => {
      console.error(`[engagement] канал «${channel.name}» упал:`, err);
      return 0;
    });
  }
  console.log(`[engagement] обновлена вовлечённость ${updated} постов`);
  return updated;
}

/** Пересчитывает подсказку классификатору по накопленной вовлечённости канала. */
function refreshHint(channel: Channel): void {
  const scored = engagementByCategory(14)
    .filter((r) => r.views >= MIN_VIEWS_FOR_HINT)
    .map((r) => ({ ...r, rate: (r.reactions + r.forwards) / r.views }))
    .sort((a, b) => b.rate - a.rate);
  if (scored.length < 2) return; // мало данных — подсказку не трогаем
  const top = scored
    .slice(0, 2)
    .map((s) => s.category)
    .join(", ");
  const low = scored[scored.length - 1]?.category ?? "";
  kvSet(
    `engagement_hint:${channel.id}`,
    `аудитория активнее всего реагирует на категории ${top}, слабее всего — ${low}. Учитывай это при выставлении importance (калибровка, а не запрет).`,
  );
}

/** Ежедневный запуск из основного цикла. */
export async function maybeCollectDailyEngagement(tg: TelegramClient): Promise<void> {
  const last = kvGet("last_engagement_at");
  if (last && Date.now() - Date.parse(last) < 24 * 3600 * 1000) return;
  kvSet("last_engagement_at", new Date().toISOString());
  await collectEngagement(tg);
}
