import { config } from "./config";
import { contentOf, llm, OPENROUTER_EXTRAS, parseJsonLoose } from "./llm";

export const CATEGORIES = [
  "safety",
  "visa_docs",
  "transport",
  "events",
  "money",
  "weather",
  "infrastructure",
  "other",
] as const;

export type Category = (typeof CATEGORIES)[number];

export type Tone = "negative" | "neutral" | "positive";

export interface Verdict {
  keep: boolean;
  reason: string;
  category: Category;
  importance: 1 | 2 | 3 | 4 | 5;
  tone: Tone;
  title: string;
  summary: string;
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    keep: { type: "boolean", description: "Публиковать ли эту новость в фиде" },
    reason: { type: "string", description: "Короткое обоснование решения" },
    category: { type: "string", enum: [...CATEGORIES] },
    importance: { type: "integer", enum: [1, 2, 3, 4, 5] },
    tone: {
      type: "string",
      enum: ["negative", "neutral", "positive"],
      description: "Эмоциональная окраска новости для читателя",
    },
    title: { type: "string", description: "Заголовок на русском, до 80 символов" },
    summary: {
      type: "string",
      description: "Суть новости на русском, 1-3 предложения, нейтральный тон",
    },
  },
  required: ["keep", "reason", "category", "importance", "tone", "title", "summary"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `Ты — редактор новостного Telegram-канала для русскоязычных экспатов на Пхукете и в Таиланде. Твоя задача — отфильтровать информационный шум и оставить только действительно полезное.

Источники бывают русские, английские и тайские — независимо от языка оригинала, заголовок и summary всегда пиши на русском. Из национальных новостей Таиланда оставляй то, что касается жизни иностранца в стране (визы, законы, транспорт, деньги, туризм); внутреннюю политику и региональные происшествия без практической пользы — выкидывай.

ОСТАВЛЯЙ (keep=true):
- визы, иммиграционные правила, законы, штрафы, требования к иностранцам
- предупреждения о безопасности: шторма, опасные пляжи и течения, схемы мошенничества, отзывы товаров
- транспорт: аэропорт, дороги, паромы, изменения маршрутов, цены
- деньги: курсы, банки, переводы, налоги
- инфраструктура: отключения воды/электричества, интернет, стройки, новые сервисы
- события и активности, полезные экспатам
- позитивные и практичные локальные новости

ВЫКИДЫВАЙ (keep=false):
- мемы, шутки, опросы, розыгрыши
- рекламу, продажи, объявления, промо экскурсий и заведений
- криминальную хронику без практической пользы для читателя ("турист утонул", "поймали наркоторговца")
- политические срачи и негатив ради негатива
- кликбейт без содержания

ТОНАЛЬНОСТЬ (tone):
- negative — новость про проблемы, опасности, запреты, подорожания
- neutral — фактическая информация без окраски
- positive — хорошие новости, улучшения, открытия, праздники
Оценивай честно: квоту негатива в фиде контролирует отдельный слой, твоя задача — точная разметка. Важность 5 ставь только критичным предупреждениям (шторм, закрытый пляж, срочные изменения правил) — они публикуются вне квоты.

Заголовок и summary пиши на русском, нейтрально и по делу, без паники и без эмодзи. Если в тексте есть конкретика (даты, суммы, адреса) — сохрани её в summary.`;

export async function classify(postText: string): Promise<Verdict> {
  const userPrompt = `Пост из канала-источника:\n"""\n${postText.slice(0, config.maxPostLength)}\n"""`;

  // Одна повторная попытка: некоторые провайдеры изредка отдают кривой JSON даже со схемой
  for (let attempt = 1; ; attempt++) {
    const response = await llm.chat.completions.create({
      model: config.llmModel,
      max_tokens: 3000,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "verdict", strict: true, schema: VERDICT_SCHEMA },
      },
      ...(OPENROUTER_EXTRAS as object),
    });

    try {
      return validateVerdict(parseJsonLoose<Verdict>(contentOf(response)));
    } catch (err) {
      if (attempt >= 2) throw err;
      console.error("Кривой ответ классификатора, повторяю запрос:", err);
    }
  }
}

const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    keep_indexes: {
      type: "array",
      items: { type: "integer" },
      description: "Номера заголовков, достойных полного разбора",
    },
  },
  required: ["keep_indexes"],
  additionalProperties: false,
} as const;

const TRIAGE_SYSTEM = `Ты — быстрый триаж-фильтр новостного канала для русскоязычных экспатов на Пхукете и в Таиланде. По заголовкам отбери те, что МОГУТ быть полезны: визы/законы, безопасность и предупреждения, транспорт, деньги, инфраструктура (вода/свет/интернет), события, погодные угрозы, практичные локальные новости. Отбрасывай очевидный шум: мемы, рекламу, криминальную хронику без пользы, политические срачи, мировые новости без связи с Таиландом, спорт, гороскопы. Сомневаешься — бери: дальше полный фильтр разберётся.`;

/** Дешёвый батч-отбор: какие из заголовков стоят полной классификации. */
export async function triage(items: { index: number; headline: string }[]): Promise<Set<number>> {
  if (items.length === 0) return new Set();
  const list = items.map((it) => `${it.index}. ${it.headline}`).join("\n");
  const response = await llm.chat.completions.create({
    model: config.llmModel,
    max_tokens: 2500, // с запасом: у reasoning-моделей размышления тоже едят лимит
    messages: [
      { role: "system", content: TRIAGE_SYSTEM },
      { role: "user", content: `Заголовки:\n${list}` },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "triage", strict: true, schema: TRIAGE_SCHEMA },
    },
    ...(OPENROUTER_EXTRAS as object),
  });
  const parsed = parseJsonLoose<{ keep_indexes: number[] }>(contentOf(response));
  return new Set(Array.isArray(parsed.keep_indexes) ? parsed.keep_indexes : []);
}

const MATCH_SCHEMA = {
  type: "object",
  properties: {
    duplicate_of: {
      type: "integer",
      description: "id совпавшего сюжета или -1, если это новый сюжет",
    },
  },
  required: ["duplicate_of"],
  additionalProperties: false,
} as const;

/** Это та же новость, что один из недавних сюжетов? Возвращает id сюжета или null. */
export async function confirmStory(
  candidate: { title: string; summary: string },
  stories: { id: number; title: string }[],
): Promise<number | null> {
  if (stories.length === 0) return null;
  const list = stories.map((s) => `${s.id}. ${s.title}`).join("\n");
  const response = await llm.chat.completions.create({
    model: config.llmModel,
    max_tokens: 1500,
    messages: [
      {
        role: "system",
        content:
          "Определи, описывает ли новая новость ТО ЖЕ событие, что один из недавних сюжетов (даже другими словами или с новыми деталями). Похожая тема ≠ то же событие: два разных шторма — разные сюжеты. Верни id совпавшего сюжета или -1.",
      },
      {
        role: "user",
        content: `Новая новость: ${candidate.title}\n${candidate.summary}\n\nНедавние сюжеты:\n${list}`,
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "story_match", strict: true, schema: MATCH_SCHEMA },
    },
    ...(OPENROUTER_EXTRAS as object),
  });
  const parsed = parseJsonLoose<{ duplicate_of: number }>(contentOf(response));
  const id = Number(parsed.duplicate_of);
  return Number.isInteger(id) && id > 0 && stories.some((s) => s.id === id) ? id : null;
}

function validateVerdict(v: Verdict): Verdict {
  if (typeof v.keep !== "boolean" || typeof v.title !== "string" || typeof v.summary !== "string") {
    throw new Error(`Вердикт не по схеме: ${JSON.stringify(v).slice(0, 200)}`);
  }
  if (!CATEGORIES.includes(v.category)) v.category = "other";
  if (!["negative", "neutral", "positive"].includes(v.tone)) v.tone = "neutral";
  if (![1, 2, 3, 4, 5].includes(v.importance)) v.importance = 3;
  return v;
}
