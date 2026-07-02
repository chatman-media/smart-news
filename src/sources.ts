export interface Source {
  username: string;
  note?: string;
}

export interface Feed {
  name: string;
  url: string;
  note?: string;
}

interface SourcesFile {
  region: string;
  channels: Source[];
  feeds?: Feed[];
}

export async function loadSources(): Promise<Source[]> {
  const file = (await Bun.file("sources.json").json()) as SourcesFile;
  return file.channels;
}

export async function loadFeeds(): Promise<Feed[]> {
  const file = (await Bun.file("sources.json").json()) as SourcesFile;
  return file.feeds ?? [];
}

/** Добавляет источник в sources.json (идемпотентно). Подхватится следующим циклом пайплайна. */
export async function addSource(
  kind: "channel" | "rss",
  ref: string,
  note: string,
): Promise<boolean> {
  const file = (await Bun.file("sources.json").json()) as SourcesFile;
  if (kind === "channel") {
    const username = ref.replace(/^@/, "");
    if (file.channels.some((c) => c.username === username)) return false;
    file.channels.push({ username, note });
  } else {
    file.feeds ??= [];
    if (file.feeds.some((f) => f.url === ref)) return false;
    const name = new URL(ref).hostname.replace(/^www\./, "");
    file.feeds.push({ name, url: ref, note });
  }
  await Bun.write("sources.json", `${JSON.stringify(file, null, 2)}\n`);
  return true;
}
