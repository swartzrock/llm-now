import { ratio as wasmRatio } from "@3leaps/string-metrics-wasm";

export function ratio(left: string, right: string): number {
  return wasmRatio(left, right);
}
