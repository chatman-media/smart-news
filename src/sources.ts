export interface Source {
  username: string;
  note?: string;
}

interface SourcesFile {
  region: string;
  channels: Source[];
}

export async function loadSources(): Promise<Source[]> {
  const file = (await Bun.file("sources.json").json()) as SourcesFile;
  return file.channels;
}
