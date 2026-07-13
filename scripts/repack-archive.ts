import { archiveMtime, createExecutableArchive, extractExecutableArchive } from "./build.ts";

const [archivePath, executablePath] = Bun.argv.slice(2);
if (!archivePath || !executablePath) throw new Error("usage: repack-archive ARCHIVE EXECUTABLE");

const entry = extractExecutableArchive(
  new Uint8Array(await Bun.file(archivePath).arrayBuffer()),
  archivePath,
);
await Bun.write(
  archivePath,
  createExecutableArchive(
    entry.name,
    new Uint8Array(await Bun.file(executablePath).arrayBuffer()),
    archiveMtime(),
  ),
);
