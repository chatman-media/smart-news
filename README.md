# smart-news

AI-агрегатор новостей для экспатов. Читает Telegram-каналы-источники через MTProto,
фильтрует шум (мемы, рекламу, чернуху, дубли) через Claude и присылает годные новости
владельцу на модерацию — кнопки «Опубликовать / Пропустить». Одобренное уходит в публичный канал.

Первый регион — **Пхукет / Таиланд**, фид на русском.

```
каналы-источники ──MTProto──▶ ingest ──▶ Claude (фильтр+суммаризация) ──▶ черновик в личку ──▶ ✅ ──▶ канал
```

## Стек

- [Bun](https://bun.sh) + TypeScript
- [mtcute](https://mtcute.dev) — чтение каналов от имени личного аккаунта (MTProto)
- [grammY](https://grammy.dev) — бот модерации и публикации
- [Anthropic API](https://platform.claude.com) — классификация и суммаризация (structured outputs)
- SQLite (`bun:sqlite`) — состояние и очередь черновиков

## Запуск

1. **Ключи Telegram API**: [my.telegram.org](https://my.telegram.org) → API development tools → `api_id` + `api_hash`.
2. **Бот**: создай в [@BotFather](https://t.me/BotFather), возьми токен. Напиши боту `/start`, чтобы он мог писать тебе в личку.
3. **Канал**: создай канал для фида, добавь бота администратором с правом публикации.
4. **Свой user id**: узнай через [@userinfobot](https://t.me/userinfobot).
5. Конфиг:

   ```sh
   cp .env.example .env   # и заполни
   bun install
   ```

6. Вход в аккаунт (один раз, сессия сохраняется):

   ```sh
   bun run login
   ```

7. Запуск:

   ```sh
   bun start        # бот + опрос источников по расписанию
   bun run once     # разовый прогон без бота (для теста)
   ```

## Источники

Список каналов — в [sources.json](sources.json). Аккаунт, под которым выполнен login,
должен иметь доступ к каналам (публичные читаются по username без подписки).

## Команды бота

- `/check` — проверить источники прямо сейчас
- Кнопки под черновиком: ✅ опубликовать в канал, ❌ пропустить

## Настройка фильтра

Правила «что оставляем / что выкидываем» — системный промпт в
[src/classify.ts](src/classify.ts). Категории: safety, visa_docs, transport,
events, money, weather, infrastructure, other.

Модель по умолчанию — `claude-opus-4-8`; для экономии можно указать
`CLAUDE_MODEL=claude-haiku-4-5` в `.env`.
