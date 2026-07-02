// Интерактивный вход в аккаунт Telegram (MTProto). Сессия сохраняется в data/mtcute-session.
import { createTelegram } from "./telegram";

const tg = createTelegram();

const self = await tg.start({
  phone: () => tg.input("Телефон (+7…) > "),
  code: () => tg.input("Код из Telegram > "),
  password: () => tg.input("Пароль 2FA > "),
});

console.log(`Вход выполнен: ${self.displayName}. Сессия сохранена, теперь можно \`bun start\`.`);
await tg.destroy();
process.exit(0);
