import { basename, join, resolve } from "node:path";

const directory = resolve(Bun.argv[2] ?? ".");
const port = Number(Bun.argv[3] ?? "8765");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("invalid port");

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  async fetch(request) {
    const requested = decodeURIComponent(new URL(request.url).pathname.slice(1));
    if (requested !== basename(requested) || !/^(?:llm-now-v[0-9.]+-[a-z0-9-]+\.zip|SHA256SUMS)$/.test(requested)) {
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(join(directory, requested));
    return await file.exists() ? new Response(file) : new Response("not found", { status: 404 });
  },
});

console.log(`serving ${directory} at ${server.url}`);
