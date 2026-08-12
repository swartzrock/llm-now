declare module "cross-spawn" {
  import type { ChildProcessWithoutNullStreams, SpawnOptions } from "node:child_process";

  export default function crossSpawn(
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ): ChildProcessWithoutNullStreams;
}
