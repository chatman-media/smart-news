import { bot, deliverDraft, registerAdminCommands, validateChannel } from "./bot";
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

// Шаги независимы: падение одного не отменяет остальные
async function tick(): Promise<void> {
  await runPipeline(tg).catch((err) => console.error("Пайплайн упал:", err));
  await maybeGenerateDailyRubric()
    .then((rubric) => (rubric ? deliverDraft(rubric) : undefined))
    .catch((err) => console.error("Рубрика упала:", err));
  await maybeRunWeeklyScout(tg).catch((err) => console.error("Скаут упал:", err));
}

await tick();

setInterval(
  () => {
    void tick();
  },
  config.pollIntervalMin * 60 * 1000,
);

console.log(`Пайплайн: опрос каждые ${config.pollIntervalMin} мин`);
