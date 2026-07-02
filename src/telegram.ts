import { TelegramClient, type User } from "@mtcute/bun";
import { config } from "./config";

export function createTelegram(): TelegramClient {
  return new TelegramClient({
    apiId: config.tgApiId,
    apiHash: config.tgApiHash,
    storage: "data/mtcute-session",
  });
}

/** Подключение с уже сохранённой сессией; без сессии — понятная ошибка. */
export async function connectAuthorized(tg: TelegramClient): Promise<User> {
  const fail = (): never => {
    throw new Error("Сессия Telegram не найдена — сначала запусти `bun run login`");
  };
  return await tg.start({ phone: fail, code: fail, password: fail });
}
