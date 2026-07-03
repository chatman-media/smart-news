// Локальная веб-админка: каналы и их источники. Слушает только 127.0.0.1.
import { config } from "./config";
import {
  addChannelSource,
  createChannel,
  deleteChannelSource,
  getChannel,
  listChannelSources,
  listChannels,
  setChannelSourceActive,
  updateChannel,
} from "./db";

const html = Bun.file(new URL("./admin.html", import.meta.url).pathname);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function normalizeRef(kind: string, raw: string): string {
  const ref = raw.trim();
  if (kind === "telegram") {
    return ref
      .replace(/^https?:\/\/t\.me\/(s\/)?/i, "")
      .replace(/^@/, "")
      .replace(/\/.*$/, "");
  }
  return ref;
}

export function startAdminServer(): void {
  const server = Bun.serve({
    port: config.adminPort,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname } = url;
      const method = req.method;

      try {
        if (method === "GET" && (pathname === "/" || pathname === "/index.html")) {
          return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
        }

        if (method === "GET" && pathname === "/api/channels") {
          const channels = listChannels().map((c) => ({
            ...c,
            sources: listChannelSources(c.id),
          }));
          return json(channels);
        }

        if (method === "POST" && pathname === "/api/channels") {
          const body = (await req.json()) as Record<string, string>;
          if (!body.name || !body.chat_id) {
            return json({ error: "нужны name и chat_id" }, 400);
          }
          const channel = createChannel({
            name: body.name,
            chat_id: body.chat_id.trim(),
            focus: body.focus || "русскоязычные экспаты в Таиланде",
            negative_quota: 20,
            auto_publish: 1,
            rubric_hour: 10,
            rubrics_enabled: 0,
            active: 1,
          });
          return json(channel, 201);
        }

        let match = pathname.match(/^\/api\/channels\/(\d+)$/);
        if (method === "PATCH" && match) {
          const id = Number(match[1]);
          if (!getChannel(id)) return json({ error: "канал не найден" }, 404);
          const patch = (await req.json()) as Record<string, unknown>;
          return json(updateChannel(id, patch));
        }

        match = pathname.match(/^\/api\/channels\/(\d+)\/sources$/);
        if (method === "POST" && match) {
          const id = Number(match[1]);
          if (!getChannel(id)) return json({ error: "канал не найден" }, 404);
          const body = (await req.json()) as Record<string, string>;
          const kind = body.kind === "rss" ? "rss" : "telegram";
          const ref = normalizeRef(kind, body.ref || "");
          if (!ref) return json({ error: "пустой ref" }, 400);
          const source = addChannelSource(id, kind, ref, body.name || ref, body.note || "");
          if (!source) return json({ error: "такой источник уже есть" }, 409);
          return json(source, 201);
        }

        match = pathname.match(/^\/api\/sources\/(\d+)$/);
        if (match && method === "PATCH") {
          const body = (await req.json()) as { active?: number };
          setChannelSourceActive(Number(match[1]), Boolean(body.active));
          return json({ ok: true });
        }
        if (match && method === "DELETE") {
          deleteChannelSource(Number(match[1]));
          return json({ ok: true });
        }

        return json({ error: "not found" }, 404);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  });
  console.log(`Админка: http://127.0.0.1:${server.port}`);
}
