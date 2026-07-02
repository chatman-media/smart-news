import Anthropic from "@anthropic-ai/sdk";
import { config } from "./config";

const anthropic = new Anthropic();

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

export interface Verdict {
  keep: boolean;
  reason: string;
  category: Category;
  importance: 1 | 2 | 3 | 4 | 5;
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
    title: { type: "string", description: "Заголовок на русском, до 80 символов" },
    summary: {
      type: "string",
      description: "Суть новости на русском, 1-3 предложения, нейтральный тон",
    },
  },
  required: ["keep", "reason", "category", "importance", "title", "summary"],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `Ты — редактор новостного Telegram-канала для русскоязычных экспатов на Пхукете и в Таиланде. Твоя задача — отфильтровать информационный шум и оставить только действительно полезное.

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
- дубли: если новость по смыслу совпадает с одним из недавних заголовков в списке — keep=false с reason="duplicate"

Заголовок и summary пиши на русском, нейтрально и по делу, без паники и без эмодзи. Если в тексте есть конкретика (даты, суммы, адреса) — сохрани её в summary.`;

export async function classify(postText: string, recentDraftTitles: string[]): Promise<Verdict> {
  const userPrompt = [
    recentDraftTitles.length > 0
      ? `Недавние заголовки (для проверки на дубли):\n${recentDraftTitles.map((t) => `- ${t}`).join("\n")}`
      : "",
    `Пост из канала-источника:\n"""\n${postText.slice(0, config.maxPostLength)}\n"""`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const response = await anthropic.messages.create({
    model: config.claudeModel,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    output_config: {
      format: { type: "json_schema", schema: VERDICT_SCHEMA },
    },
  });

  if (response.stop_reason === "refusal") {
    return {
      keep: false,
      reason: "refusal",
      category: "other",
      importance: 1,
      title: "",
      summary: "",
    };
  }

  const text = response.content.find((b) => b.type === "text")?.text;
  if (!text) {
    throw new Error(`Пустой ответ модели (stop_reason=${response.stop_reason})`);
  }
  return JSON.parse(text) as Verdict;
}
