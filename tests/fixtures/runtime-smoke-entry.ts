import { isByokProviderId } from "@swartzrock/byok-runtime";
import { createByokNodeProvider } from "@swartzrock/byok-runtime/node";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  loadConfig,
  loadConfigSnapshot,
  migrateConfig,
  resolveConfigPaths,
  saveConfigAlias,
} from "../../src/config.ts";
import { serializeConfigDocument } from "../../src/config-schema.ts";
import { routeTranscript } from "../../src/voice-routing.ts";

const fakeCli = Bun.argv[2];
const isolationRoot = Bun.argv[3];
if (!fakeCli) throw new Error("missing fake CLI path");
if (!isolationRoot) throw new Error("missing isolated runtime root");
const runtimeRoot = isolationRoot;
if (!isByokProviderId("ollama")) throw new Error("root runtime export unavailable");
if (process.cwd() !== runtimeRoot) throw new Error("compiled smoke must run outside the checkout");
if (await Bun.file(join(process.cwd(), "node_modules", "smol-toml", "package.json")).exists()) {
  throw new Error("compiled smoke must not use repository dependencies");
}

const httpProvider = createByokNodeProvider(
  { provider: "ollama", url: "http://runtime-smoke.invalid", model: "fake-model" },
  {
    http: async () => ({
      status: 200,
      text: JSON.stringify({ response: "http-ok" }),
      json: { response: "http-ok" },
    }),
  },
);
const cliProvider = createByokNodeProvider({ provider: "codex-cli", command: fakeCli });

const http = await httpProvider.generateText({ prompt: "smoke" });
const cli = await cliProvider.generateText({ prompt: "smoke" });

function isolatedPaths(name: string) {
  const root = join(runtimeRoot, name);
  const configHome = join(root, "config");
  return resolveConfigPaths({
    platform: process.platform,
    home: join(root, "home"),
    env: process.platform === "win32"
      ? { APPDATA: configHome }
      : { XDG_CONFIG_HOME: configHome },
  });
}

const freshPaths = isolatedPaths("fresh");
const freshResult = await saveConfigAlias(freshPaths, "Daily", {
  provider: "codex-cli",
  model: null,
  instructions: 'Use "quoted" compiled instructions.\nKeep them concise.',
});
if (freshResult !== "saved") throw new Error(`unexpected fresh save result: ${freshResult}`);
const freshDocument = await loadConfig(freshPaths.configPath);
if (freshDocument === null) throw new Error("compiled fresh save did not create config.toml");
const freshText = await Bun.file(freshPaths.configPath).text();
if (serializeConfigDocument(freshDocument) !== freshText) {
  throw new Error("compiled fresh config is not canonical after reload");
}
if (/wake_words|min_fuzzy_phrase_length|min_similarity|min_margin|match_phrases|voice\s*=|rate\s*=|pitch\s*=/.test(freshText)) {
  throw new Error("compiled fresh config materialized omitted voice defaults");
}
const freshSnapshot = await loadConfigSnapshot(freshPaths);
if (
  freshSnapshot.authority !== "unified"
  || freshSnapshot.voice.wakeWords.join("\n") !== "hey"
  || freshSnapshot.voice.minFuzzyPhraseLength !== 4
  || freshSnapshot.voice.minSimilarity !== 65
  || freshSnapshot.voice.minMargin !== 15
) throw new Error("compiled fresh config did not reload omission defaults");

const migrationPaths = isolatedPaths("migration");
await mkdir(dirname(migrationPaths.legacyAliasPath), { recursive: true });
const legacyAliases = `${JSON.stringify({
  version: 2,
  aliases: {
    terra: {
      provider: "codex-cli",
      model: null,
      instructions: "Migrated compiled instructions.",
    },
  },
}, null, 2)}\n`;
const legacyVoice = [
  'wake_words = ["computer"]',
  "",
  "[terra]",
  'match_phrases = ["tara"]',
  'voice = "Samantha"',
  "rate = 205",
  "pitch = 50",
  "",
].join("\n");
await Bun.write(migrationPaths.legacyAliasPath, legacyAliases);
await Bun.write(migrationPaths.legacyVoicePath, legacyVoice);
const migration = await migrateConfig(migrationPaths);
if (migration.kind !== "migrated" || migration.staleProfiles.length !== 0) {
  throw new Error(`unexpected compiled migration result: ${JSON.stringify(migration)}`);
}
const migratedSnapshot = await loadConfigSnapshot(migrationPaths);
const migratedDocument = migratedSnapshot.document;
if (migratedSnapshot.authority !== "unified" || migratedDocument === null) {
  throw new Error("compiled migration did not publish unified authority");
}
const migratedText = await Bun.file(migrationPaths.configPath).text();
if (serializeConfigDocument(migratedDocument) !== migratedText) {
  throw new Error("compiled migrated config is not canonical after reload");
}
const migratedProfile = migratedSnapshot.voice.profiles.terra;
if (
  migratedSnapshot.voice.wakeWords.join("\n") !== "computer"
  || migratedProfile?.matchPhrases.join("\n") !== "tara"
  || migratedProfile.voice !== "Samantha"
  || migratedProfile.rate !== 205
  || migratedProfile.pitch !== 50
) throw new Error("compiled migration did not preserve voice overrides");
if (
  await Bun.file(`${migrationPaths.legacyAliasPath}.pre-unified-v1.bak`).text() !== legacyAliases
  || await Bun.file(`${migrationPaths.legacyVoicePath}.pre-unified-v1.bak`).text() !== legacyVoice
) throw new Error("compiled migration backups do not preserve legacy bytes");
const migratedRoute = routeTranscript(
  "Computer tara, question",
  Object.keys(migratedSnapshot.aliases),
  migratedSnapshot.voice,
);
if (
  migratedRoute.alias !== "terra"
  || migratedRoute.question !== "question"
  || migratedRoute.reason !== "configured"
) throw new Error(`compiled migrated routing failed: ${JSON.stringify(migratedRoute)}`);

process.stdout.write(`${http.text}\n${cli.text}\nconfig-defaults-ok\nmigration-routing-ok\n`);
