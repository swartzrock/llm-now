import { unzipSync } from "fflate";
import { createExecutableArchive } from "./build.ts";

const [archivePath, executablePath] = Bun.argv.slice(2);
if (!archivePath || !executablePath) throw new Error("usage: repack-archive ARCHIVE EXECUTABLE");

const entries = unzipSync(new Uint8Array(await Bun.file(archivePath).arrayBuffer()));
const names = Object.keys(entries);
if (names.length !== 1 || !["llm-now", "llm-now.exe"].includes(names[0]!)) {
  throw new Error("archive must contain exactly one llm-now executable");
}
await Bun.write(
  archivePath,
  createExecutableArchive(names[0]!, new Uint8Array(await Bun.file(executablePath).arrayBuffer())),
);
