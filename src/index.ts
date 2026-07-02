import { bot, registerAdminCommands, sendDraftToAdmin } from "./bot";
import { config } from "./config";
import { runPipeline } from "./pipeline";
import { ensureTopicsSeeded, generateRubric, maybeGenerateDailyRubric } from "./rubrics";
import { connectAuthorized, createTelegram } from "./telegram";

const tg = createTelegram();
await connectAuthorized(tg);
console.log("MTProto: подключено");

ensureTopicsSeeded();

registerAdminCommands(() => runPipeline(tg), generateRubric);
void bot.start({
  onStart: (me) => console.log(`Бот: @${me.username} запущен`),
});

async function tick(): Promise<void> {
  await runPipeline(tg);
  const rubric = await maybeGenerateDailyRubric();
  if (rubric) await sendDraftToAdmin(rubric);
}

await tick().catch((err) => console.error("Первый прогон упал:", err));

setInterval(
  () => {
    tick().catch((err) => console.error("Прогон упал:", err));
  },
  config.pollIntervalMin * 60 * 1000,
);

console.log(`Пайплайн: опрос каждые ${config.pollIntervalMin} мин`);
