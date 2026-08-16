import { BYOK_PROVIDER_IDS, type ByokProviderId } from "@swartzrock/byok-runtime";

export const LLM_NOW_ERROR_CODES = Object.freeze([
  "INVALID_REQUEST",
  "PROVIDER_UNAVAILABLE",
  "CREDENTIAL_UNAVAILABLE",
  "CREDENTIAL_RESOLUTION_FAILED",
  "EXECUTION_UNAVAILABLE",
  "WORKSPACE_UNAVAILABLE",
  "DISCOVERY_FAILED",
  "MODEL_LIST_FAILED",
  "VALIDATION_FAILED",
  "GENERATION_FAILED",
  "ABORTED",
  "UNSAFE_RESPONSE",
  "DELTA_HANDLER_FAILED",
  "INTERNAL_ERROR",
] as const);

export type LlmNowErrorCode = (typeof LLM_NOW_ERROR_CODES)[number];

export const LLM_NOW_OPERATIONS = Object.freeze([
  "discovery",
  "model-list",
  "validation",
  "generation",
  "streaming",
] as const);

export type LlmNowOperation = (typeof LLM_NOW_OPERATIONS)[number];

const ERROR_MESSAGES: Readonly<Record<LlmNowErrorCode, string>> = Object.freeze({
  INVALID_REQUEST: "The request is invalid.",
  PROVIDER_UNAVAILABLE: "The provider is unavailable.",
  CREDENTIAL_UNAVAILABLE: "A required credential is unavailable.",
  CREDENTIAL_RESOLUTION_FAILED: "Credential resolution failed.",
  EXECUTION_UNAVAILABLE: "CLI execution is unavailable.",
  WORKSPACE_UNAVAILABLE: "The requested workspace is unavailable.",
  DISCOVERY_FAILED: "Provider discovery failed.",
  MODEL_LIST_FAILED: "Model listing failed.",
  VALIDATION_FAILED: "Connection validation failed.",
  GENERATION_FAILED: "Text generation failed.",
  ABORTED: "The operation was aborted.",
  UNSAFE_RESPONSE: "The provider response was withheld.",
  DELTA_HANDLER_FAILED: "The text delta handler failed.",
  INTERNAL_ERROR: "The core operation failed safely.",
});

function errorCodes(...values: LlmNowErrorCode[]): ReadonlySet<LlmNowErrorCode> {
  return new Set(values);
}

const ALLOWED_CODES: Readonly<Record<LlmNowOperation, ReadonlySet<LlmNowErrorCode>>> = Object.freeze({
  discovery: errorCodes(
    "INVALID_REQUEST",
    "CREDENTIAL_RESOLUTION_FAILED",
    "DISCOVERY_FAILED",
    "ABORTED",
    "INTERNAL_ERROR",
  ),
  "model-list": errorCodes(
    "INVALID_REQUEST",
    "PROVIDER_UNAVAILABLE",
    "CREDENTIAL_UNAVAILABLE",
    "CREDENTIAL_RESOLUTION_FAILED",
    "EXECUTION_UNAVAILABLE",
    "MODEL_LIST_FAILED",
    "ABORTED",
    "INTERNAL_ERROR",
  ),
  validation: errorCodes(
    "INVALID_REQUEST",
    "PROVIDER_UNAVAILABLE",
    "CREDENTIAL_UNAVAILABLE",
    "CREDENTIAL_RESOLUTION_FAILED",
    "EXECUTION_UNAVAILABLE",
    "VALIDATION_FAILED",
    "ABORTED",
    "INTERNAL_ERROR",
  ),
  generation: errorCodes(
    "INVALID_REQUEST",
    "PROVIDER_UNAVAILABLE",
    "CREDENTIAL_UNAVAILABLE",
    "CREDENTIAL_RESOLUTION_FAILED",
    "EXECUTION_UNAVAILABLE",
    "WORKSPACE_UNAVAILABLE",
    "GENERATION_FAILED",
    "ABORTED",
    "UNSAFE_RESPONSE",
    "INTERNAL_ERROR",
  ),
  streaming: errorCodes(
    "INVALID_REQUEST",
    "PROVIDER_UNAVAILABLE",
    "CREDENTIAL_UNAVAILABLE",
    "CREDENTIAL_RESOLUTION_FAILED",
    "EXECUTION_UNAVAILABLE",
    "WORKSPACE_UNAVAILABLE",
    "GENERATION_FAILED",
    "ABORTED",
    "UNSAFE_RESPONSE",
    "DELTA_HANDLER_FAILED",
    "INTERNAL_ERROR",
  ),
});

const ERROR_CODE_SET = new Set<string>(LLM_NOW_ERROR_CODES);
const OPERATION_SET = new Set<string>(LLM_NOW_OPERATIONS);
const PROVIDER_SET = new Set<string>(BYOK_PROVIDER_IDS);
const INSPECT = Symbol.for("nodejs.util.inspect.custom");

function knownOperation(value: unknown): LlmNowOperation {
  return typeof value === "string" && OPERATION_SET.has(value)
    ? value as LlmNowOperation
    : "generation";
}

function knownCode(value: unknown, operation: LlmNowOperation): LlmNowErrorCode {
  if (typeof value !== "string" || !ERROR_CODE_SET.has(value)) return "INTERNAL_ERROR";
  const code = value as LlmNowErrorCode;
  return ALLOWED_CODES[operation].has(code) ? code : "INTERNAL_ERROR";
}

function knownProvider(value: unknown): ByokProviderId | undefined {
  return typeof value === "string" && PROVIDER_SET.has(value)
    ? value as ByokProviderId
    : undefined;
}

export function isErrorCodeAllowedForOperation(
  operation: LlmNowOperation,
  code: LlmNowErrorCode,
): boolean {
  return ALLOWED_CODES[operation].has(code);
}

export class LlmNowError extends Error {
  declare readonly code: LlmNowErrorCode;
  declare readonly operation: LlmNowOperation;
  declare readonly provider?: ByokProviderId;

  constructor(
    code: LlmNowErrorCode,
    operation: LlmNowOperation,
    provider?: ByokProviderId,
  ) {
    const safeOperation = knownOperation(operation);
    const safeCode = knownCode(code, safeOperation);
    super(ERROR_MESSAGES[safeCode]);
    for (const property of Object.getOwnPropertyNames(this)) {
      if (property !== "message") Reflect.deleteProperty(this, property);
    }
    Object.defineProperties(this, {
      name: { value: "LlmNowError", enumerable: false },
      code: { value: safeCode, enumerable: true },
      operation: { value: safeOperation, enumerable: true },
      ...(knownProvider(provider) === undefined
        ? {}
        : { provider: { value: knownProvider(provider), enumerable: true } }),
      [INSPECT]: {
        enumerable: false,
        value: () => {
          const providerText = this.provider === undefined ? "" : `, provider: ${this.provider}`;
          return `LlmNowError { code: ${this.code}, operation: ${this.operation}${providerText} }`;
        },
      },
    });
    Object.freeze(this);
  }
}

export function safeErrorFromUnknown(
  operation: LlmNowOperation,
  fallbackCode: LlmNowErrorCode,
  provider: ByokProviderId | undefined,
  _unknownValue: unknown,
): LlmNowError {
  return new LlmNowError(fallbackCode, operation, provider);
}
