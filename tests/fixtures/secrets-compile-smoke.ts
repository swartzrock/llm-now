import {
  createBunNativeSecretAdapter,
  type NativeSecretAdapter,
} from "../../src/credentials.ts";

type LifecycleStage =
  | "missing"
  | "set"
  | "get"
  | "replace"
  | "get-replacement"
  | "delete"
  | "missing-after-delete"
  | "cleanup";

export async function runNativeSecretLifecycle(
  adapter: NativeSecretAdapter,
  report: (stage: LifecycleStage) => void,
): Promise<void> {
  const suffix = crypto.randomUUID();
  const identity = {
    service: `llm-now-lifecycle-${suffix}`,
    name: `probe-${suffix}`,
  };
  const first = `synthetic-native-secret-a-${suffix}`;
  const replacement = `synthetic-native-secret-b-${suffix}`;
  let stage: LifecycleStage = "missing";
  let failure: Error | undefined;

  try {
    stage = "missing";
    if (await adapter.get(identity) !== null) throw new Error();
    report(stage);

    stage = "set";
    await adapter.set(identity, first);
    report(stage);

    stage = "get";
    if (await adapter.get(identity) !== first) throw new Error();
    report(stage);

    stage = "replace";
    await adapter.set(identity, replacement);
    report(stage);

    stage = "get-replacement";
    if (await adapter.get(identity) !== replacement) throw new Error();
    report(stage);

    stage = "delete";
    if (!await adapter.delete(identity)) throw new Error();
    report(stage);

    stage = "missing-after-delete";
    if (await adapter.get(identity) !== null) throw new Error();
    report(stage);
  } catch {
    failure = new Error(`native credential lifecycle failed: ${stage}`);
  } finally {
    try {
      await adapter.delete(identity);
      if (await adapter.get(identity) !== null) throw new Error();
      report("cleanup");
    } catch {
      failure ??= new Error("native credential lifecycle failed: cleanup");
    }
  }

  if (failure !== undefined) throw failure;
}

if (import.meta.main) {
  try {
    await runNativeSecretLifecycle(
      createBunNativeSecretAdapter(),
      (stage) => console.log(`native credential lifecycle: ${stage}`),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "native credential lifecycle failed");
    process.exitCode = 1;
  }
}
