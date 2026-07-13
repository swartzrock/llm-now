import { saveAlias } from "../../src/aliases.ts";

const [path, name, model] = process.argv.slice(2);
if (path === undefined || name === undefined || model === undefined) process.exit(2);
await saveAlias(path, name, { provider: "ollama", model });
