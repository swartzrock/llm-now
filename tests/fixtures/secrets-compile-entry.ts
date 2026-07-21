import { createBunNativeSecretAdapter } from "../../src/credentials.ts";
import { runNativeSecretLifecycle } from "./secrets-compile-smoke.ts";

try {
  await runNativeSecretLifecycle(
    createBunNativeSecretAdapter(),
    (stage) => console.log(`native credential lifecycle: ${stage}`),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : "native credential lifecycle failed");
  process.exitCode = 1;
}
