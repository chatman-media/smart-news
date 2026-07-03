// Умный подбор картинок: vision-проверка изображений из источников
// и генерация фотоиллюстраций для постов, оставшихся без пригодного медиа.
import { config } from "./config";
import { contentOf, llm } from "./llm";

export interface GeneratedMedia {
  type: "photo";
  path: string;
}

/** Генерирует фотоиллюстрацию по смыслу новости. null — если выключено или модель не вернула картинку. */
export async function generateIllustration(
  title: string,
  summary: string,
  fileBase: string,
): Promise<GeneratedMedia | null> {
  if (!config.imageModel) return null;
  const prompt = `Photorealistic editorial illustration for a news post about Thailand.
News (in Russian): "${title}" — ${summary}
Authentic Thai scenery and objects matching the topic, natural light, editorial photography style, high quality.
Strictly NO text, NO captions, NO watermarks, NO logos in the image.`;

  const response = await llm.chat.completions.create({
    model: config.imageModel,
    messages: [{ role: "user", content: prompt }],
  });

  const message = response.choices[0]?.message as
    | { images?: { image_url?: { url?: string } }[] }
    | undefined;
  const dataUrl = message?.images?.[0]?.image_url?.url;
  if (!dataUrl?.startsWith("data:image")) return null;

  const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
  const safeBase = fileBase.replace(/[^a-zA-Z0-9_-]/g, "_");
  const path = `data/media/${safeBase}_gen.png`;
  await Bun.write(path, bytes);
  return { type: "photo", path };
}

/**
 * Проверяет vision-моделью, уместна ли картинка из источника.
 * Провайдеры vision-моделей игнорируют json_schema — поэтому бинарный протокол одним словом.
 * При ошибке (например, сайт блокирует хотлинк картинки) отвечает «уместна» — пост не блокируем.
 */
export async function imageFits(imageUrl: string, title: string): Promise<boolean> {
  try {
    const response = await llm.chat.completions.create({
      model: config.visionModel,
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageUrl } },
            {
              type: "text",
              text: `Новость: «${title}». Годится ли эта картинка как иллюстрация к посту в новостном Telegram-канале? НЕ годятся: логотипы изданий, баннеры и заглушки сайтов, картинки с крупным текстом, реклама, явно нерелевантные изображения. Обычное фото по теме — годится. Не рассуждай, ответь ровно одним словом: FITS или UNFIT.`,
            },
          ],
        },
      ],
    });
    return !/UNFIT/i.test(contentOf(response));
  } catch (err) {
    console.error("Vision-проверка картинки не сработала, оставляю как есть:", err);
    return true;
  }
}
