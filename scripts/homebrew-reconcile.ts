import { Buffer } from "node:buffer";
import { join } from "node:path";
import { compareStableVersions, parseStableVersion, validateCommitSha } from "./release-plan.ts";

export const HOMEBREW_TAP = {
  owner: "swartzrock",
  repository: "homebrew-tap",
  branch: "main",
  path: "Formula/llm-now.rb",
} as const;

export const MAX_FORMULA_BYTES = 64 * 1024;
const MAX_API_RESPONSE_BYTES = 256 * 1024;
const API_VERSION = "2026-03-10";
const stableTagPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const blobShaPattern = /^[a-f0-9]{40}$/;
const safeRequestIdPattern = /^[A-Za-z0-9._:-]{1,128}$/;

const formulaTokens = [
  "__PACKAGE_VERSION__",
  "__MACOS_ARM64_URL__",
  "__MACOS_ARM64_SHA256__",
  "__MACOS_X64_URL__",
  "__MACOS_X64_SHA256__",
  "__LINUX_ARM64_URL__",
  "__LINUX_ARM64_SHA256__",
  "__LINUX_X64_URL__",
  "__LINUX_X64_SHA256__",
] as const;

type FormulaToken = (typeof formulaTokens)[number];
type FormulaState =
  | { kind: "exact"; version: string }
  | { kind: "older-valid"; version: string }
  | { kind: "same-version-divergent"; version: string }
  | { kind: "newer"; version: string }
  | { kind: "invalid" };

export type ReconciliationDisposition =
  | "updated"
  | "already-current"
  | "failed-before-write"
  | "write-outcome-unconfirmed";

export interface ReconciliationReceipt {
  disposition: ReconciliationDisposition;
  phase: "input-validation" | "read-live" | "write" | "read-back";
  reason: string;
  tag: string;
  releaseSha: string;
  tap: typeof HOMEBREW_TAP;
  httpStatus: number | null;
  requestId: string | null;
}

interface ReconcileOptions {
  desiredFormula: string;
  template: string;
  tag: string;
  releaseSha: string;
  token?: string;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}

interface LiveFormula {
  formula: string;
  sha: string;
}

interface ReadResult {
  live: LiveFormula | null;
  reason: string | null;
  httpStatus: number | null;
  requestId: string | null;
}

function receipt(
  options: Pick<ReconcileOptions, "tag" | "releaseSha">,
  disposition: ReconciliationDisposition,
  phase: ReconciliationReceipt["phase"],
  reason: string,
  httpStatus: number | null,
  requestId: string | null,
): ReconciliationReceipt {
  return {
    disposition,
    phase,
    reason,
    tag: options.tag,
    releaseSha: options.releaseSha,
    tap: HOMEBREW_TAP,
    httpStatus,
    requestId,
  };
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsUnsafeControl(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if ((code < 0x20 && code !== 0x0a) || code === 0x7f) return true;
  }
  return false;
}

function tokenPattern(token: FormulaToken): string {
  if (token === "__PACKAGE_VERSION__") {
    return "(?<version>(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*))";
  }
  if (token.endsWith("_SHA256__")) return `(?<${token.slice(2, -2).toLowerCase()}>[a-f0-9]{64})`;
  return `(?<${token.slice(2, -2).toLowerCase()}>[^"\\r\\n]+)`;
}

function formulaPattern(template: string): RegExp | null {
  const tokenSet = new Set<FormulaToken>(formulaTokens);
  const seen = new Set<FormulaToken>();
  let pattern = "^";
  let cursor = 0;

  for (const match of template.matchAll(/__[A-Z0-9_]+__/g)) {
    const token = match[0] as FormulaToken;
    if (!tokenSet.has(token) || seen.has(token)) return null;
    seen.add(token);
    pattern += escapePattern(template.slice(cursor, match.index));
    pattern += tokenPattern(token);
    cursor = match.index + token.length;
  }
  if (seen.size !== formulaTokens.length) return null;
  pattern += `${escapePattern(template.slice(cursor))}$`;
  return new RegExp(pattern);
}

function expectedUrl(version: string, target: string): string {
  return `https://github.com/swartzrock/llm-now/releases/download/v${version}/llm-now-v${version}-${target}.zip`;
}

export function parseManagedHomebrewFormula(
  formula: string,
  template: string,
): { version: string } | null {
  if (
    Buffer.byteLength(formula) === 0 ||
    Buffer.byteLength(formula) > MAX_FORMULA_BYTES ||
    containsUnsafeControl(formula)
  ) return null;

  const pattern = formulaPattern(template);
  const match = pattern?.exec(formula);
  const groups = match?.groups;
  const version = groups?.version;
  if (!groups || !version) return null;

  try {
    parseStableVersion(version);
  } catch {
    return null;
  }

  const urls: ReadonlyArray<readonly [string, string]> = [
    ["macos_arm64_url", "macos-arm64"],
    ["macos_x64_url", "macos-x64"],
    ["linux_arm64_url", "linux-arm64"],
    ["linux_x64_url", "linux-x64"],
  ];
  for (const [group, target] of urls) {
    if (groups[group] !== expectedUrl(version, target)) return null;
  }
  return { version };
}

export function classifyHomebrewFormula(
  desiredFormula: string,
  liveFormula: string,
  template: string,
): FormulaState {
  const desired = parseManagedHomebrewFormula(desiredFormula, template);
  if (!desired) return { kind: "invalid" };
  if (liveFormula === desiredFormula) return { kind: "exact", version: desired.version };

  const live = parseManagedHomebrewFormula(liveFormula, template);
  if (!live) return { kind: "invalid" };
  const comparison = compareStableVersions(live.version, desired.version);
  if (comparison < 0) return { kind: "older-valid", version: live.version };
  if (comparison > 0) return { kind: "newer", version: live.version };
  return { kind: "same-version-divergent", version: live.version };
}

function requestId(response: Response): string | null {
  const value = response.headers.get("x-github-request-id");
  return value && safeRequestIdPattern.test(value) ? value : null;
}

async function readBoundedText(response: Response): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > MAX_API_RESPONSE_BYTES)) {
    throw new Error("response-too-large");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("response-too-large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function decodeFormulaContent(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.replace(/\r?\n/g, "");
  if (
    compact.length === 0 ||
    compact.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(compact)
  ) return null;
  const bytes = Buffer.from(compact, "base64");
  if (bytes.toString("base64") !== compact || bytes.byteLength > MAX_FORMULA_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function readLiveFormula(
  fetchImpl: typeof fetch,
  endpoint: string,
  token: string,
): Promise<ReadResult> {
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint}?ref=${HOMEBREW_TAP.branch}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": API_VERSION,
      },
    });
  } catch {
    return { live: null, reason: "live-read-transport-failed", httpStatus: null, requestId: null };
  }

  const metadata = { httpStatus: response.status, requestId: requestId(response) };
  if (response.status === 404) return { live: null, reason: "live-formula-missing", ...metadata };
  if (response.status !== 200) return { live: null, reason: "live-read-failed", ...metadata };

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedText(response));
  } catch {
    return { live: null, reason: "invalid-live-response", ...metadata };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { live: null, reason: "invalid-live-response", ...metadata };
  }
  const record = parsed as Record<string, unknown>;
  const formula = decodeFormulaContent(record.content);
  if (
    record.type !== "file" ||
    record.path !== HOMEBREW_TAP.path ||
    record.encoding !== "base64" ||
    typeof record.sha !== "string" ||
    !blobShaPattern.test(record.sha) ||
    formula === null
  ) return { live: null, reason: "invalid-live-response", ...metadata };

  return { live: { formula, sha: record.sha }, reason: null, ...metadata };
}

function stateFailureReason(state: FormulaState): string {
  switch (state.kind) {
    case "same-version-divergent": return "same-version-divergent";
    case "newer": return "newer-live-formula";
    case "invalid": return "invalid-live-formula";
    default: return "invalid-live-formula";
  }
}

export async function reconcileHomebrewFormula(
  options: ReconcileOptions,
): Promise<ReconciliationReceipt> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiUrl = (options.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const endpoint = `${apiUrl}/repos/${HOMEBREW_TAP.owner}/${HOMEBREW_TAP.repository}/contents/${HOMEBREW_TAP.path}`;
  const tagMatch = stableTagPattern.exec(options.tag);

  if (!options.token?.trim()) {
    return receipt(options, "failed-before-write", "input-validation", "missing-token", null, null);
  }
  try {
    validateCommitSha(options.releaseSha, "release SHA");
  } catch {
    return receipt(options, "failed-before-write", "input-validation", "invalid-release-sha", null, null);
  }
  const desired = parseManagedHomebrewFormula(options.desiredFormula, options.template);
  if (!tagMatch || !desired || desired.version !== options.tag.slice(1)) {
    return receipt(options, "failed-before-write", "input-validation", "invalid-desired-formula", null, null);
  }

  const initial = await readLiveFormula(fetchImpl, endpoint, options.token);
  if (!initial.live) {
    return receipt(
      options,
      "failed-before-write",
      "read-live",
      initial.reason ?? "live-read-failed",
      initial.httpStatus,
      initial.requestId,
    );
  }

  const state = classifyHomebrewFormula(options.desiredFormula, initial.live.formula, options.template);
  if (state.kind === "exact") {
    return receipt(options, "already-current", "read-live", "exact", initial.httpStatus, initial.requestId);
  }
  if (state.kind !== "older-valid") {
    return receipt(
      options,
      "failed-before-write",
      "read-live",
      stateFailureReason(state),
      initial.httpStatus,
      initial.requestId,
    );
  }

  let writeStatus: number | null = null;
  let writeRequestId: string | null = null;
  try {
    const response = await fetchImpl(endpoint, {
      method: "PUT",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": API_VERSION,
      },
      body: JSON.stringify({
        message: `Update llm-now to ${desired.version}`,
        content: Buffer.from(options.desiredFormula).toString("base64"),
        sha: initial.live.sha,
        branch: HOMEBREW_TAP.branch,
      }),
    });
    writeStatus = response.status;
    writeRequestId = requestId(response);
    await response.body?.cancel();
  } catch {
    // The write may have committed before the transport failed. Read back once.
  }

  const readBack = await readLiveFormula(fetchImpl, endpoint, options.token);
  if (readBack.live?.formula === options.desiredFormula) {
    const writeConfirmed = writeStatus === 200 || writeStatus === 201;
    return receipt(
      options,
      writeConfirmed ? "updated" : "already-current",
      "read-back",
      writeConfirmed ? "exact-after-update" : "exact-after-ambiguous-update",
      writeStatus,
      writeRequestId,
    );
  }
  return receipt(
    options,
    "write-outcome-unconfirmed",
    "read-back",
    readBack.live ? "non-exact-read-back" : "read-back-unavailable",
    writeStatus,
    writeRequestId,
  );
}

async function main(): Promise<void> {
  const [desiredPath, tag, releaseSha, receiptPath] = Bun.argv.slice(2);
  if (!desiredPath || !tag || !releaseSha || !receiptPath) {
    throw new Error("usage: homebrew-reconcile DESIRED_FORMULA TAG RELEASE_SHA RECEIPT_PATH");
  }

  let result: ReconciliationReceipt;
  try {
    const [desiredFormula, template] = await Promise.all([
      Bun.file(desiredPath).text(),
      Bun.file(join(import.meta.dir, "../packaging/homebrew/llm-now.rb")).text(),
    ]);
    result = await reconcileHomebrewFormula({
      desiredFormula,
      template,
      tag,
      releaseSha,
      token: process.env.HOMEBREW_TAP_TOKEN,
    });
  } catch {
    result = receipt(
      { tag, releaseSha },
      "failed-before-write",
      "input-validation",
      "input-read-failed",
      null,
      null,
    );
  }

  await Bun.write(receiptPath, `${JSON.stringify(result)}\n`);
  console.log(`Homebrew reconciliation: ${result.disposition} (${result.reason})`);
  if (result.disposition !== "updated" && result.disposition !== "already-current") {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch {
    console.error("Homebrew reconciliation failed before receipt output");
    process.exitCode = 1;
  }
}
