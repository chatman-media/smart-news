import { bot, registerAdminCommands, sendDraftToAdmin, validateChannel } from "./bot";
import { config } from "./config";
import { runPipeline } from "./pipeline";
import { ensureTopicsSeeded, generateRubric, maybeGenerateDailyRubric } from "./rubrics";
import { maybeRunWeeklyScout, runScout } from "./scout";
import { connectAuthorized, createTelegram } from "./telegram";

const tg = createTelegram();
const self = await connectAuthorized(tg);
config.adminChatId ??= self.id;
console.log(`MTProto: подключено как ${self.displayName} (id ${self.id})`);

ensureTopicsSeeded();

await validateChannel();
registerAdminCommands(
  () => runPipeline(tg),
  generateRubric,
  () => runScout(tg),
);
void bot.start({
  onStart: (me) => console.log(`Бот: @${me.username} запущен`),
});

async function tick(): Promise<void> {
  await runPipeline(tg);
  const rubric = await maybeGenerateDailyRubric();
  if (rubric) await sendDraftToAdmin(rubric);
  await maybeRunWeeklyScout(tg);
}

await tick().catch((err) => console.error("Первый прогон упал:", err));

setInterval(
  () => {
    tick().catch((err) => console.error("Прогон упал:", err));
  },
  config.pollIntervalMin * 60 * 1000,
);

console.log(`Пайплайн: опрос каждые ${config.pollIntervalMin} мин`);
