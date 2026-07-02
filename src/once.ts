// Разовый прогон пайплайна без запуска бота (кнопки работать не будут — только доставка черновиков)
import { config } from "./config";
import { runPipeline } from "./pipeline";
import { connectAuthorized, createTelegram } from "./telegram";

const tg = createTelegram();
const self = await connectAuthorized(tg);
config.adminChatId ??= self.id;

const drafts = await runPipeline(tg);
console.log(`Готово: ${drafts} новых черновиков`);
await tg.destroy();
process.exit(0);
