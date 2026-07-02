import { bot, registerAdminCommands } from "./bot";
import { config } from "./config";
import { runPipeline } from "./pipeline";
import { connectAuthorized, createTelegram } from "./telegram";

const tg = createTelegram();
await connectAuthorized(tg);
console.log("MTProto: подключено");

registerAdminCommands(() => runPipeline(tg));
void bot.start({
  onStart: (me) => console.log(`Бот: @${me.username} запущен`),
});

await runPipeline(tg).catch((err) => console.error("Первый прогон упал:", err));

setInterval(
  () => {
    runPipeline(tg).catch((err) => console.error("Прогон упал:", err));
  },
  config.pollIntervalMin * 60 * 1000,
);

console.log(`Пайплайн: опрос каждые ${config.pollIntervalMin} мин`);
