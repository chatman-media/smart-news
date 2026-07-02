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
