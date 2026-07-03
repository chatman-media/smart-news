// Ежедневные авторские рубрики: генерируются LLM с живым веб-поиском, а не парсятся.
import { config } from "./config";
import {
  type Draft,
  hasRubricToday,
  insertDraft,
  lastRubricCategory,
  markRubricTopicUsed,
  pickRubricTopic,
  seedRubricTopics,
} from "./db";
import { contentOf, llm } from "./llm";
import { ACTIVITIES, PLACES } from "./rubric-topics";

export type RubricKind = "place" | "activity";

const RUBRIC_PROMPTS: Record<RubricKind, (topic: string) => string> = {
  place: (topic) =>
    `Напиши пост рубрики «Уголок Таиланда» про: ${topic}.
Расскажи живо и конкретно: что это за место, чем там занимаются туристы и чем живут местные, что стоит попробовать, лайфхак от своих. Если через веб-поиск найдёшь что-то актуальное (сезон, события, изменения) — вплети.`,
  activity: (topic) =>
    `Напиши пост рубрики «Чем заняться в Тае» про: ${topic}.
Конкретика для экспата на Пхукете: где, почём примерно, с чего начать, на что обратить внимание. Если через веб-поиск найдёшь актуальные детали — используй.`,
};

const RUBRIC_SYSTEM = `Ты — автор Telegram-канала для русскоязычных экспатов на Пхукете и в Таиланде.
Пиши на русском, дружелюбно и по делу, без канцелярита, без рекламных интонаций и без выдуманных фактов. Цены и часы работы указывай только если уверен или нашёл в поиске, иначе обходись без них.

Формат ответа строго такой:
- первая строка — заголовок (до 70 символов, без эмодзи и кавычек)
- пустая строка
- 2–4 коротких абзаца текста (всего 400–800 символов)`;

export function ensureTopicsSeeded(): void {
  seedRubricTopics("place", PLACES);
  seedRubricTopics("activity", ACTIVITIES);
}

export async function generateRubric(kind: RubricKind): Promise<Draft | null> {
  const topic = pickRubricTopic(kind);
  if (!topic) return null;

  // Суффикс :online включает веб-поиск на стороне OpenRouter
  const response = await llm.chat.completions.create({
    model: `${config.llmModel}:online`,
    // с большим запасом: reasoning + результаты веб-поиска едят лимит до ответа
    max_tokens: 8000,
    messages: [
      { role: "system", content: RUBRIC_SYSTEM },
      { role: "user", content: RUBRIC_PROMPTS[kind](topic) },
    ],
  });

  const text = contentOf(response);

  const newlineIdx = text.indexOf("\n");
  const title = (newlineIdx === -1 ? text : text.slice(0, newlineIdx)).trim();
  const body = (newlineIdx === -1 ? "" : text.slice(newlineIdx)).trim();
  if (!title || !body) throw new Error(`Не удалось распарсить рубрику про «${topic}»`);

  markRubricTopicUsed(kind, topic);

  return insertDraft({
    source: "rubric",
    source_msg_id: Date.now(),
    link: "",
    title,
    summary: body,
    category: kind,
    importance: 3,
    tone: "positive",
    media_type: null,
    media_path: null,
  });
}

/** Раз в день после config.rubricHour генерирует рубрику, чередуя «место» и «занятие». */
export async function maybeGenerateDailyRubric(): Promise<Draft | null> {
  if (new Date().getHours() < config.rubricHour) return null;
  if (hasRubricToday()) return null;
  const kind: RubricKind = lastRubricCategory() === "place" ? "activity" : "place";
  return generateRubric(kind);
}
