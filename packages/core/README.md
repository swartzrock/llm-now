# @swartzrock/llm-now-core

Headless provider operations and transcript routing for trusted Node and Bun hosts.

The package is ESM-only. It supports Node 20 or later and Bun 1.3.14 or later.
Import only the package root:

```ts
import { createLlmNowCore, routeTranscript } from "@swartzrock/llm-now-core";
```

## Install and verify an exact Release

Core is distributed as an npm-format tarball on an immutable GitHub Release,
not through npmjs. Choose one exact version and download both public assets:

```bash
curl --fail --location --remote-name \
  https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/swartzrock-llm-now-core-X.Y.Z.tgz
curl --fail --location --remote-name \
  https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/SHA256SUMS
sha256sum --check --strict --status SHA256SUMS
```

Verify the action artifact attestation against the exact Release source SHA,
then verify the immutable Release attestation and its tarball asset:

```bash
gh attestation verify swartzrock-llm-now-core-X.Y.Z.tgz \
  --repo swartzrock/llm-now \
  --signer-workflow swartzrock/llm-now/.github/workflows/release-core.yml \
  --source-digest <SHA>
gh release verify core-vX.Y.Z --repo swartzrock/llm-now
gh release verify-asset core-vX.Y.Z swartzrock-llm-now-core-X.Y.Z.tgz --repo swartzrock/llm-now
```

After verification, install the same exact version URL and commit your
lockfile. Do not replace `X.Y.Z` with a floating latest-Release URL.

```bash
npm install "https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/swartzrock-llm-now-core-X.Y.Z.tgz"
# or: bun add "https://github.com/swartzrock/llm-now/releases/download/core-vX.Y.Z/swartzrock-llm-now-core-X.Y.Z.tgz"
```

The manifest's `private: true` prevents npm publication; it is not a visibility
control. The repository source and GitHub Release assets remain public.
Installing the tarball can still resolve its transitive dependencies through
the package manager's configured registries.

Hosts supply an environment snapshot, a credential resolver, and, when they
approve CLI providers, a CLI execution resolver. Importing the package and
constructing a client do not read host configuration or start provider work.

```ts
import { createLlmNowCore } from "@swartzrock/llm-now-core";

const environment = Object.freeze({ ...process.env });
const core = createLlmNowCore({
  environment,
  credentialResolver: {
    async resolve(provider, signal) {
      signal?.throwIfAborted();
      const variable = provider === "openai" ? "OPENAI_API_KEY" : undefined;
      const credential = variable === undefined ? undefined : environment[variable];
      return credential ? { status: "resolved", credential } : { status: "missing" };
    },
  },
});

const result = await core.generateText({
  provider: "openai",
  model: "gpt-5-mini",
  prompt: "Summarize this request.",
});
```

The host owns credentials, approved CLI execution, timeouts, routing candidates,
and voice selection. The core does not expose the `llm-now` CLI's configuration
or `Bun.secrets` vault.

Read the complete [API contract](https://github.com/swartzrock/llm-now/blob/main/docs/core-api.md)
and [security contract](https://github.com/swartzrock/llm-now/blob/main/docs/core-security.md)
before integrating the package.
