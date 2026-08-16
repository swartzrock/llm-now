# `@swartzrock/llm-now-core`

Headless provider operations and transcript routing for trusted Node and Bun hosts.

The package is ESM-only. It supports Node 20 or later and Bun 1.3.14 or later.
Import only the package root:

```ts
import { createLlmNowCore, routeTranscript } from "@swartzrock/llm-now-core";
```

Hosts supply an environment snapshot, a credential resolver, and, when they
approve CLI providers, a CLI execution resolver. Importing the package and
constructing a client do not read host configuration or start provider work.

The complete API and security contract is maintained in the llm-now
repository documentation.
