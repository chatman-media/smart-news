import { startAdminServer } from "./admin";
import { bot, registerAdminCommands, validateChannels } from "./bot";
import { config } from "./config";
import { maybeCollectDailyEngagement } from "./engagement";
import { runPipeline } from "./pipeline";
import { ensureTopicsSeeded, generateRubric, maybeGenerateDailyRubrics } from "./rubrics";
import { maybeRunWeeklyScout, runScoutAll } from "./scout";
import { seedChannelsIfEmpty } from "./sources";
import { connectAuthorized, createTelegram } from "./telegram";

const tg = createTelegram();
const self = await connectAuthorized(tg);
config.adminChatId ??= self.id;
console.log(`MTProto: подключено как ${self.displayName} (id ${self.id})`);

await seedChannelsIfEmpty();
ensureTopicsSeeded();
startAdminServer();

await validateChannels();
registerAdminCommands(
  () => runPipeline(tg),
  generateRubric,
  () => runScoutAll(tg),
);
void bot.start({
  onStart: (me) => console.log(`Бот: @${me.username} запущен`),
});

// Шаги независимы: падение одного не отменяет остальные
async function tick(): Promise<void> {
  await runPipeline(tg).catch((err) => console.error("Пайплайн упал:", err));
  await maybeGenerateDailyRubrics().catch((err) => console.error("Рубрика упала:", err));
  await maybeRunWeeklyScout(tg).catch((err) => console.error("Скаут упал:", err));
  await maybeCollectDailyEngagement(tg).catch((err) =>
    console.error("Сбор вовлечённости упал:", err),
  );
}

await tick();

setInterval(
  () => {
    void tick();
  },
  config.pollIntervalMin * 60 * 1000,
);

console.log(`Пайплайн: опрос каждые ${config.pollIntervalMin} мин`);
