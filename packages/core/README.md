# @swartzrock/llm-now-core

Headless provider operations and transcript routing for trusted Node and Bun hosts.

The package is ESM-only. It supports Node 20 or later and Bun 1.3.14 or later.
Import only the package root:

```ts
import { createLlmNowCore, routeTranscript } from "@swartzrock/llm-now-core";
```

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
