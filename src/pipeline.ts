import type { TelegramClient } from "@mtcute/bun";
import { sendDraftToAdmin } from "./bot";
import { classify } from "./classify";
import { config } from "./config";
import { getLastMsgId, insertDraft, negativeShare, recentTitles, setLastMsgId } from "./db";
import { loadSources } from "./sources";

let running = false;

/** Один проход: источники → новые посты → фильтр Claude → черновики админу. Возвращает число новых черновиков. */
export async function runPipeline(tg: TelegramClient): Promise<number> {
  if (running) return 0;
  running = true;
  try {
    return await runPipelineInner(tg);
  } finally {
    running = false;
  }
}

async function runPipelineInner(tg: TelegramClient): Promise<number> {
  const sources = await loadSources();
  let newDrafts = 0;

  for (const source of sources) {
    const lastId = getLastMsgId(source.username);
    const limit = lastId === 0 ? config.firstRunLimit : config.perCycleLimit;

    const messages: { id: number; text: string }[] = [];
    try {
      for await (const msg of tg.iterHistory(source.username, { limit, minId: lastId })) {
        messages.push({ id: msg.id, text: msg.text ?? "" });
      }
    } catch (err) {
      console.error(`[${source.username}] не удалось получить историю:`, err);
      continue;
    }

    // iterHistory отдаёт от новых к старым — обрабатываем по порядку
    messages.sort((a, b) => a.id - b.id);

    for (const msg of messages) {
      if (msg.text.trim().length < config.minPostLength) {
        setLastMsgId(source.username, msg.id);
        continue;
      }

      try {
        const verdict = await classify(msg.text, recentTitles());
        // Квота негатива: критичные предупреждения (importance 5) проходят всегда
        if (
          verdict.keep &&
          verdict.tone === "negative" &&
          verdict.importance < 5 &&
          negativeShare() * 100 >= config.negativeQuotaPct
        ) {
          verdict.keep = false;
          verdict.reason = "negative_quota";
        }
        if (verdict.keep) {
          const draft = insertDraft({
            source: source.username,
            source_msg_id: msg.id,
            link: `https://t.me/${source.username}/${msg.id}`,
            title: verdict.title,
            summary: verdict.summary,
            category: verdict.category,
            importance: verdict.importance,
            tone: verdict.tone,
          });
          if (draft) {
            await sendDraftToAdmin(draft);
            newDrafts++;
          }
        } else {
          console.log(`[${source.username}/${msg.id}] отфильтровано: ${verdict.reason}`);
        }
        // Помечаем прочитанным только после успешной обработки — при сбое повторим в следующем цикле
        setLastMsgId(source.username, msg.id);
      } catch (err) {
        console.error(`[${source.username}/${msg.id}] ошибка классификации:`, err);
        break; // остальное в этом канале догоним следующим циклом
      }
    }
  }

  return newDrafts;
}
