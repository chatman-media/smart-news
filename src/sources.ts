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
