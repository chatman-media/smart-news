// Разовый прогон пайплайна без запуска бота (кнопки работать не будут — только доставка черновиков)
import { runPipeline } from "./pipeline";
import { connectAuthorized, createTelegram } from "./telegram";

const tg = createTelegram();
await connectAuthorized(tg);

const drafts = await runPipeline(tg);
console.log(`Готово: ${drafts} новых черновиков`);
await tg.destroy();
process.exit(0);
