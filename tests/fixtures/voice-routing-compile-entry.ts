import { ratio } from "../../src/voice-routing.ts";

const first = ratio("deepseek32", "deepseek32");
const repeated = ratio("tara", "terra");

if (first !== 100 || Math.abs(repeated - 66.66666666666667) > Number.EPSILON) {
  throw new Error(`unexpected similarity scores: ${first}, ${repeated}`);
}

process.stdout.write(`${first}\n${repeated}\n`);
