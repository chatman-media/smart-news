// Единая точка доступа к LLM через OpenRouter (OpenAI-совместимый API).
import OpenAI from "openai";
import { config } from "./config";

export const llm = new OpenAI({
  baseURL: "https://openrouter.ai/api/v1",
  apiKey: config.openrouterApiKey,
  defaultHeaders: {
    "HTTP-Referer": "https://github.com/chatman-media/smart-news",
    "X-Title": "smart-news",
  },
});

// Просим OpenRouter роутить только на провайдеров, поддерживающих запрошенные параметры
// (иначе response_format молча игнорируется и модель возвращает вольный текст)
export const OPENROUTER_EXTRAS = { provider: { require_parameters: true } };

/** Парсит JSON из ответа модели, прощая типичные грехи: ```-ограждения, текст вокруг, незакавыченные ключи. */
export function parseJsonLoose<T>(raw: string): T {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(text) as T;
  } catch {}
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const inner = text.slice(start, end + 1);
    try {
      return JSON.parse(inner) as T;
    } catch {}
    try {
      return JSON.parse(inner.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')) as T;
    } catch {}
  }
  throw new Error(`Модель вернула не-JSON: ${text.slice(0, 200)}`);
}

/** Достаёт текст ответа; убирает возможные ```-ограждения вокруг JSON. */
export function contentOf(completion: OpenAI.Chat.ChatCompletion): string {
  const message = completion.choices[0]?.message;
  if (!message?.content) {
    throw new Error(
      `Пустой ответ модели (finish_reason=${completion.choices[0]?.finish_reason ?? "?"})`,
    );
  }
  return message.content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
}
