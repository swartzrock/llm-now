import { access, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await access(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

const originalFetch = globalThis.fetch;
let importFetches = 0;
let ollamaFixtureOrigin = null;
globalThis.fetch = async (input, init) => {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  if (
    ollamaFixtureOrigin !== null
    && url.href === "http://localhost:11434/api/generate"
  ) {
    const redirected = new URL(url.pathname, ollamaFixtureOrigin);
    return input instanceof Request
      ? originalFetch(new Request(redirected, input))
      : originalFetch(redirected, init);
  }
  importFetches++;
  throw new Error(`unexpected external network I/O: ${url.origin}`);
};

const homeBaseline = (await readdir(process.env.HOME)).sort();
const coreModule = await import("@swartzrock/llm-now-core");
assert(JSON.stringify(Object.keys(coreModule).sort()) === JSON.stringify([
  "LlmNowError",
  "RoutingInputError",
  "compactRoutingKey",
  "createLlmNowCore",
  "routeTranscript",
  "routingSimilarity",
  "workspaceCapabilities",
]), "unexpected runtime exports");

let credentialCalls = 0;
const client = coreModule.createLlmNowCore({
  environment: {},
  credentialResolver: {
    resolve: async () => {
      credentialCalls++;
      return { status: "missing" };
    },
  },
});
assert(importFetches === 0, "import or construction used fetch");
assert(credentialCalls === 0, "construction resolved a credential");
const homeAfterConstruction = (await readdir(process.env.HOME)).sort();
const homeAfterConstructionRecursive = homeAfterConstruction.length === 0
  ? []
  : await readdir(process.env.HOME, { recursive: true });
assert(
  JSON.stringify(homeAfterConstruction) === JSON.stringify(homeBaseline),
  `construction wrote into HOME: ${JSON.stringify({
    homeBaseline,
    homeAfterConstruction,
    homeAfterConstructionRecursive,
  })}`,
);

const routed = coreModule.routeTranscript({
  transcript: "hello computer tara, explain streams",
  candidates: [{
    id: "character:terra",
    canonicalName: "terra",
    alternateSpokenNames: ["tara"],
  }],
  wakeWords: ["hello computer"],
  minFuzzyPhraseLength: 4,
  minSimilarity: 65,
  minMargin: 15,
});
assert(routed.accepted && routed.candidateId === "character:terra", "routing failed");
assert(routed.question === "explain streams", "routing changed the question");
try {
  coreModule.routeTranscript(null);
  throw new Error("malformed routing input unexpectedly succeeded");
} catch (error) {
  assert(error instanceof coreModule.RoutingInputError, "wrong routing input error");
}

const preAborted = new AbortController();
preAborted.abort();
await client.generateText({
  provider: "ollama",
  model: "fixture",
  prompt: "must not perform I/O",
  signal: preAborted.signal,
}).then(
  () => { throw new Error("pre-aborted generation unexpectedly succeeded"); },
  (error) => assert(error instanceof coreModule.LlmNowError && error.code === "ABORTED", "wrong abort error"),
);
assert(importFetches === 0, "pre-aborted generation used fetch");

await client.generateText({
  provider: "codex-cli",
  model: "fixture",
  prompt: "must not launch",
}).then(
  () => { throw new Error("CLI generation without a resolver unexpectedly succeeded"); },
  (error) => assert(
    error instanceof coreModule.LlmNowError && error.code === "EXECUTION_UNAVAILABLE",
    "wrong missing-execution error",
  ),
);

const markerBase = `${process.env.HOME}/fake-cli`;
assert(typeof process.env.CORE_FIXTURE_EXECUTABLE === "string", "fake CLI executable is missing");
assert(typeof process.env.CORE_FIXTURE_CLI === "string", "fake CLI path is missing");
let executionResolverCalls = 0;
let executionProvider = null;
let executionSignalAborted = null;
const executionDescriptor = {
  mode: "direct",
  executable: process.env.CORE_FIXTURE_EXECUTABLE,
  argsPrefix: [process.env.CORE_FIXTURE_CLI, markerBase],
  env: { LLM_NOW_CORE_FIXTURE: "approved" },
};
const cliClient = coreModule.createLlmNowCore({
  environment: {},
  credentialResolver: { resolve: async () => ({ status: "missing" }) },
  cliExecutionResolver: {
    resolve: async (provider, signal) => {
      executionResolverCalls++;
      executionProvider = provider;
      executionSignalAborted = signal?.aborted ?? null;
      return provider === "codex-cli" ? executionDescriptor : null;
    },
  },
});

const buffered = await cliClient.generateText({
  provider: "codex-cli",
  model: "fixture",
  prompt: "hello",
}).catch((error) => {
  throw new Error(`fake CLI generation failed: ${JSON.stringify({
    executionResolverCalls,
    executionProvider,
    executionSignalAborted,
    executionDescriptor,
  })}`, { cause: error });
});
const bufferedDeltas = [];
const bufferedStream = await cliClient.streamText({
  provider: "codex-cli",
  model: "fixture",
  prompt: "hello",
}, (delta) => bufferedDeltas.push(delta));
assert(buffered.text === "fixture:hello", "fake CLI generation failed");
assert(bufferedStream.delivery === "buffered", "fake CLI delivery was not buffered");
assert(bufferedStream.text === buffered.text, "buffered and streamed text differ");
assert(bufferedDeltas.join("") === buffered.text, "buffered deltas differ from final text");

const cancelled = new AbortController();
const cancellation = cliClient.generateText({
  provider: "codex-cli",
  model: "fixture",
  prompt: "cancel",
  signal: cancelled.signal,
});
await waitForFile(`${markerBase}.started`);
cancelled.abort();
await cancellation.then(
  () => { throw new Error("cancelled CLI generation unexpectedly succeeded"); },
  (error) => assert(error instanceof coreModule.LlmNowError && error.code === "ABORTED", "wrong CLI abort error"),
);
await waitForFile(`${markerBase}.stopped`);

const server = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  const input = JSON.parse(body);
  if (request.url !== "/api/generate") {
    response.writeHead(404).end();
    return;
  }
  if (input.stream === false) {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ response: `native:${input.prompt}` }));
    return;
  }
  response.setHeader("content-type", "application/x-ndjson");
  response.write(`${JSON.stringify({ response: "native:", done: false })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20));
  response.end(`${JSON.stringify({ response: input.prompt, done: true })}\n`);
});
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address !== null && typeof address === "object", "fixture server address is missing");
  ollamaFixtureOrigin = `http://127.0.0.1:${address.port}`;

  const nativeBuffered = await client.generateText({
    provider: "ollama",
    model: "fixture",
    prompt: "hello",
  });
  let firstDeltaResolve;
  const firstDelta = new Promise((resolve) => { firstDeltaResolve = resolve; });
  let releaseHandler;
  const handlerRelease = new Promise((resolve) => { releaseHandler = resolve; });
  const nativeDeltas = [];
  let streamSettled = false;
  const nativeOperation = client.streamText({
    provider: "ollama",
    model: "fixture",
    prompt: "hello",
  }, async (delta) => {
    nativeDeltas.push(delta);
    if (nativeDeltas.length === 1) {
      firstDeltaResolve();
      await handlerRelease;
    }
  }).finally(() => { streamSettled = true; });
  await firstDelta;
  assert(nativeDeltas[0] === "native:", "native stream did not deliver its first delta");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(!streamSettled && nativeDeltas.length === 1, "stream did not await delta backpressure");
  releaseHandler();
  const nativeStream = await nativeOperation;
  assert(nativeStream.delivery === "native", "Ollama delivery was not native");
  assert(nativeStream.text === nativeBuffered.text, "native stream and buffered text differ");
  assert(nativeDeltas.join("") === nativeStream.text, "native deltas differ from final text");
} finally {
  ollamaFixtureOrigin = null;
  globalThis.fetch = originalFetch;
  if (server.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }
}

await import("@swartzrock/llm-now-core/dist/index.js").then(
  () => { throw new Error("deep import unexpectedly succeeded"); },
  () => undefined,
);
assert(JSON.stringify((await readdir(process.env.HOME))
  .filter((name) => !name.startsWith("fake-cli."))
  .sort()) === JSON.stringify(homeBaseline), "core operations wrote an unexpected HOME file");

process.stdout.write(`${JSON.stringify({ runtime: process.release.name, status: "passed" })}\n`);
