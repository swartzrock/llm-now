import {
  serializeConfigDocument,
  type ConfigDocumentV1,
} from "../../packages/cli/src/config-schema.ts";

const document: ConfigDocumentV1 = {
  version: 1,
  sharedInstructions: "Shared guidance.",
  default: { alias: "terra" },
  voice: {
    wakeWords: ["hey", "computer"],
    minFuzzyPhraseLength: 3,
    minSimilarity: 72,
    minMargin: 9,
  },
  aliases: {
    terra: {
      provider: "codex-cli",
      model: "default",
      instructions: "Answer concisely.",
      spokenNames: ["tara"],
      voice: "Samantha",
      rate: 205,
      pitch: 50.5,
    },
  },
};

process.stdout.write(serializeConfigDocument(document));
