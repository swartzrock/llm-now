import { homedir } from "node:os";
import packageMetadata from "./package.json" with { type: "json" };
import { createApplicationPrompter, runApplication } from "./src/app.ts";
import {
  createBunCredentialVault,
  createCredentialResolver,
  createSensitiveValueRegistry,
  isNativeVaultEnabled,
} from "./src/credentials.ts";
import { createRuntimeGateway } from "./src/runtime.ts";

const sensitive = createSensitiveValueRegistry();
const credentialVault = createBunCredentialVault();
const nativeVaultEnabled = isNativeVaultEnabled({
  bunVersion: Bun.version,
  platform: process.platform,
  arch: process.arch,
});
const credentialResolver = createCredentialResolver({
  env: process.env,
  vault: credentialVault,
  vaultEnabled: nativeVaultEnabled,
});

process.exitCode = await runApplication({
  args: Bun.argv.slice(2),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  runtime: createRuntimeGateway({ env: process.env, credentialResolver, sensitive }),
  prompter: createApplicationPrompter(process.stdin, process.stderr),
  env: process.env,
  platform: process.platform,
  home: homedir(),
  version: packageMetadata.version,
  credentialVault,
  credentialResolver,
  sensitive,
  nativeVaultEnabled,
});
