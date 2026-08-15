import { saveAlias } from "../../packages/cli/src/aliases.ts";
import { migrateConfig, saveConfigAlias } from "../../packages/cli/src/config.ts";

const args = process.argv.slice(2);
if (args[0] === "--migrate") {
  const [, configPath, legacyAliasPath, legacyVoicePath] = args;
  if (configPath === undefined || legacyAliasPath === undefined || legacyVoicePath === undefined) {
    process.exit(2);
  }
  await migrateConfig({ configPath, legacyAliasPath, legacyVoicePath });
} else if (args.length === 5) {
  const [configPath, legacyAliasPath, legacyVoicePath, name, model] = args;
  if (
    configPath === undefined
    || legacyAliasPath === undefined
    || legacyVoicePath === undefined
    || name === undefined
    || model === undefined
  ) process.exit(2);
  await saveConfigAlias(
    { configPath, legacyAliasPath, legacyVoicePath },
    name,
    { provider: "ollama", model },
  );
} else {
  const [path, name, model] = args;
  if (path === undefined || name === undefined || model === undefined) process.exit(2);
  await saveAlias(path, name, { provider: "ollama", model });
}
