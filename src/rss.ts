// Инжест RSS-первоисточников (английские и тайские издания).
import { XMLParser } from "fast-xml-parser";
import type { Feed } from "./sources";

export interface FeedItem {
  guid: string;
  title: string;
  text: string;
  link: string;
  imageUrl: string | null;
}

const parser = new XMLParser({ ignoreAttributes: false });

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "#text" in value) {
    return textOf((value as Record<string, unknown>)["#text"]);
  }
  return "";
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Картинка статьи: enclosure → media:content → первый <img> из html. */
function imageOf(item: Record<string, unknown>, html: string): string | null {
  const fromAttr = (node: unknown): string | null => {
    for (const n of Array.isArray(node) ? node : [node]) {
      const url = (n as Record<string, unknown> | null)?.["@_url"];
      if (typeof url === "string" && url.startsWith("http")) return url;
    }
    return null;
  };
  const enclosure = fromAttr(item.enclosure);
  if (enclosure) return enclosure;
  const mediaContent = fromAttr(item["media:content"]) ?? fromAttr(item["media:thumbnail"]);
  if (mediaContent) return mediaContent;
  const img = html.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  return img?.[1] ?? null;
}

/** Atom-ссылка: <link href="..."/> (может быть массивом). */
function hrefOf(node: unknown): string {
  for (const n of Array.isArray(node) ? node : [node]) {
    const href = (n as Record<string, unknown> | null)?.["@_href"];
    if (typeof href === "string") return href;
  }
  return "";
}

export async function fetchFeedItems(feed: Feed, limit: number): Promise<FeedItem[]> {
  const response = await fetch(feed.url, {
    headers: {
      "user-agent": USER_AGENT,
      accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} от ${feed.url}`);
  }
  const xml = await response.text();
  const doc = parser.parse(xml);

  const result: FeedItem[] = [];

  const rawRss = doc?.rss?.channel?.item;
  const rawAtom = doc?.feed?.entry;
  if (rawRss) {
    const items: unknown[] = Array.isArray(rawRss) ? rawRss : [rawRss];
    for (const raw of items.slice(0, limit)) {
      const item = raw as Record<string, unknown>;
      const title = stripHtml(textOf(item.title));
      const link = textOf(item.link).trim();
      const guid = textOf(item.guid).trim() || link;
      const rawHtml = textOf(item["content:encoded"]) || textOf(item.description);
      const body = stripHtml(rawHtml);
      if (!guid || !title) continue;
      result.push({
        guid,
        title,
        link,
        text: `${title}\n\n${body}`,
        imageUrl: imageOf(item, rawHtml),
      });
    }
  } else if (rawAtom) {
    // Atom (в т.ч. YouTube: https://www.youtube.com/feeds/videos.xml?channel_id=...)
    const entries: unknown[] = Array.isArray(rawAtom) ? rawAtom : [rawAtom];
    for (const raw of entries.slice(0, limit)) {
      const entry = raw as Record<string, unknown>;
      const media = entry["media:group"] as Record<string, unknown> | undefined;
      const title = stripHtml(textOf(entry.title));
      const link = hrefOf(entry.link);
      const guid = textOf(entry.id).trim() || link;
      const body = stripHtml(
        textOf(media?.["media:description"]) || textOf(entry.summary) || textOf(entry.content),
      );
      if (!guid || !title) continue;
      result.push({
        guid,
        title,
        link,
        text: `${title}\n\n${body}`.slice(0, 4000),
        imageUrl: imageOf({ "media:content": media?.["media:thumbnail"] }, ""),
      });
    }
  }

  return result;
}

/** Стабильный 53-битный id из guid — для UNIQUE(source, source_msg_id) в drafts. */
export function guidToId(guid: string): number {
  return Number(BigInt(Bun.hash(guid)) & 0x1f_ffff_ffff_ffffn);
}
