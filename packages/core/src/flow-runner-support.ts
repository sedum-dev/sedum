import { BrowserDriverError } from "./browser-driver.js";
import type { ClassifiedFlowSentence } from "./flow-classification.js";
import type { FlowDiagnostic, FlowSource } from "./flow-types.js";
import type { ResolvedDataEntry } from "./flow-values.js";
import { type ProviderCall, ProviderError } from "./provider.js";
import type { ResultCall } from "./run-result.js";
import { StepExecutionError } from "./step-executor.js";
import type { FlowRunResult } from "./flow-runner-contracts.js";

type FlowFile = string;
type FailureMessage = string;
type EntryUrlText = string;

interface EntryUrlOptions {
  readonly testUrl: EntryUrlText | undefined;
  readonly baseUrl: EntryUrlText | undefined;
  readonly urlOverride: EntryUrlText | undefined;
}

/** @internal */
export function resultCall(
  call: ProviderCall,
  purpose: ResultCall["purpose"],
  apiMs: number | null = null,
): ResultCall {
  return {
    purpose,
    ...(call.provider ? { provider: call.provider } : {}),
    ...(call.modality ? { modality: call.modality } : {}),
    requestedModel: call.requestedModel,
    model: call.model,
    attempts: call.attempts,
    inputTokens: call.usage.inputTokens,
    outputTokens: call.usage.outputTokens,
    apiMs,
    inputUsdPerMillion: call.rate?.inputUsdPerMillion ?? null,
    outputUsdPerMillion: call.rate?.outputUsdPerMillion ?? null,
    rateSource: call.rate?.source ?? null,
    rateCheckedAt: call.rate?.checkedAt ?? null,
    costUsd: call.totalCostUsd,
    ...(call.rateLimited ? { rateLimited: true } : {}),
    ...(call.rateLimitWaitMs ? { rateLimitWaitMs: call.rateLimitWaitMs } : {}),
    ...(call.queueWaitMs ? { queueWaitMs: call.queueWaitMs } : {}),
  };
}

/** @internal */
export function firstDiagnostic(
  diagnostics: readonly FlowDiagnostic[],
): FlowRunResult {
  const diagnostic = diagnostics.find((item) => item.severity === "error");
  return {
    status: "could_not_run",
    file: diagnostic?.source.file ?? "",
    code: "invalid_test",
    message: diagnostic?.message ?? "The test file could not be validated.",
    ...(diagnostic?.fix ? { fix: diagnostic.fix } : {}),
    ...(diagnostic ? { source: diagnostic.source } : {}),
  };
}

/** @internal */
export function unsupported(
  file: FlowFile,
  source: FlowSource,
  message: FailureMessage,
): FlowRunResult {
  return {
    status: "could_not_run",
    file,
    code: "unsupported_test",
    source,
    message,
  };
}

/** Provider failures name the cause the provider reported, like `sedum doctor`. */
export function providerFailure(
  file: string,
  error: ProviderError,
): Extract<FlowRunResult, { status: "could_not_run" }> {
  const details: Partial<
    Record<
      ProviderError["code"],
      { readonly message: string; readonly fix: string }
    >
  > = {
    "rate-limited": {
      message: "The provider kept rate limiting requests for five minutes.",
      fix: "Lower --parallel or --provider-concurrency, or retry later.",
    },
    authentication: {
      message: "The model provider rejected the API key.",
      fix: "Set the selected provider's API key (TYPESAFE_API_KEY or CLOUDFLARE_AUTH_TOKEN), check it with `sedum doctor`, then rerun.",
    },
    configuration: {
      message: "The model provider is not configured correctly.",
      fix: "Check the selected provider's credentials, account or endpoint, and model with `sedum doctor`, then rerun.",
    },
  };
  return {
    status: "could_not_run",
    file,
    code:
      error.code === "rate-limited"
        ? "provider_rate_limited"
        : `provider_${error.code}`,
    ...(details[error.code] ?? {
      message: "The model provider could not complete the run safely.",
      fix: "Check provider availability and the test input, then rerun the test.",
    }),
  };
}

const NAVIGATION_FAILURES: Readonly<Record<string, string>> = {
  timeout: "it took too long to respond",
  "net::ERR_NAME_NOT_RESOLVED": "the host name could not be resolved (DNS)",
  "net::ERR_CONNECTION_REFUSED": "the server refused the connection",
  "net::ERR_INTERNET_DISCONNECTED": "there is no network connection",
};

function describeNavigationCode(code: string): string {
  if (code.includes("TIMED_OUT")) return "it took too long to respond";
  if (code.startsWith("net::ERR_CERT_"))
    return "its TLS certificate was rejected";
  return `the browser reported ${code}`;
}

/** A navigation failure, in words: which network problem stopped it. */
export function navigationWhy(error: StepExecutionError): string {
  const code = /(net::ERR_[A-Z_]+|timeout)$/.exec(error.message)?.[1];
  if (!code) return "the browser could not load it";
  return NAVIGATION_FAILURES[code] ?? describeNavigationCode(code);
}

/** @internal */
export function runtimeFailure(file: FlowFile, error: unknown): FlowRunResult {
  if (error instanceof BrowserDriverError) {
    const details: Record<
      typeof error.code,
      { readonly message: string; readonly fix: string }
    > = {
      "browser-missing": {
        message: "No supported browser binary was found.",
        fix: "Run `sedum browsers install chromium`, then rerun the test.",
      },
      "browser-launch-failed": {
        message: "The browser could not be started safely.",
        fix: "Check the browser installation and permissions, then rerun the test.",
      },
      "browser-disconnected": {
        message: "The browser disconnected during the run.",
        fix: "Restart the browser run and check browser stability if it repeats.",
      },
      "context-closed": {
        message: "The browser context closed during the run.",
        fix: "Rerun the test and check browser stability if it repeats.",
      },
      "page-closed": {
        message: "The browser page closed during the run.",
        fix: "Rerun the test and check whether the tested page closes itself.",
      },
      "page-crashed": {
        message: "The browser page crashed during the run.",
        fix: "Rerun the test and check browser resource usage if it repeats.",
      },
      "operation-failed": {
        message: "A browser operation could not be completed safely.",
        fix: "Check the named test step and rerun the test.",
      },
      "script-missing": {
        message: "The Sedum browser script was unavailable.",
        fix: "Rebuild or reinstall Sedum, then rerun the test.",
      },
    };
    return {
      status: "could_not_run",
      file,
      code: error.code,
      ...details[error.code],
    };
  }
  if (error instanceof ProviderError) return providerFailure(file, error);
  if (error instanceof StepExecutionError && error.op === "goto")
    return {
      status: "could_not_run",
      file,
      code: "navigation_failed",
      message: `Could not open the test's page: ${navigationWhy(error)}.`,
      fix: "Check the test's url (or baseUrl), your network or VPN, and that the site is up.",
    };
  return {
    status: "could_not_run",
    file,
    code: "execution_error",
    message: "The browser run could not be completed safely.",
    fix: "Check the browser, provider, and test input, then rerun the test.",
  };
}

export const CLAIM_PREFIX =
  /^\s*(?:verify|assert|check|confirm|ensure|expect|measure|note|observe|wait\s+(?:up\s+to\s+\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\s+)?(?:until|for))\b\s*(?:that\s+|whether\s+|if\s+)?/iu;

/** Puts model-visible values into a sentence; secrets stay placeholders. */
export function withValues(
  text: string,
  data: Readonly<Record<string, ResolvedDataEntry>>,
): string {
  return text.replace(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
    (placeholder, key: string) =>
      data[key]?.modelVisible ? data[key].value.reveal() : placeholder,
  );
}

export function claim(
  step: ClassifiedFlowSentence,
  data: Readonly<Record<string, ResolvedDataEntry>>,
): string {
  return step.text
    .replace(
      /^\s*(?:verify|assert|check|confirm|ensure|expect|measure|note|observe|wait\s+(?:up\s+to\s+\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\s+)?(?:until|for))\b\s*(?:that\s+|whether\s+|if\s+)?/iu,
      "",
    )
    .trim()
    .replace(
      /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/gu,
      (placeholder, key: string) =>
        data[key]?.modelVisible ? data[key].value.reveal() : placeholder,
    );
}

/** SED-10 entry URL semantics; SED-33 adds origin-preserving --url-override. */
export function resolveEntryUrl(
  testUrl?: EntryUrlText,
  baseUrl?: EntryUrlText,
  urlOverride?: EntryUrlText,
): string {
  const options = { testUrl, baseUrl, urlOverride };
  const resolved = resolveConfiguredUrl(options);
  const override = parseUrlOverride(options.urlOverride);
  if (override) applyOriginOverride(resolved, override);
  return resolved.href;
}

function resolveConfiguredUrl({ testUrl, baseUrl }: EntryUrlOptions): URL {
  if (!testUrl) return resolveBaseUrl(baseUrl);
  try {
    return baseUrl ? new URL(testUrl, baseUrl) : new URL(testUrl);
  } catch {
    throw new Error(
      baseUrl
        ? "The test URL is invalid relative to the configured baseUrl."
        : "The test URL is relative but no baseUrl is configured.",
    );
  }
}

function resolveBaseUrl(baseUrl: EntryUrlText | undefined): URL {
  if (baseUrl) return new URL(baseUrl);
  throw new Error("The test has no URL and no baseUrl is configured.");
}

function parseUrlOverride(
  urlOverride: EntryUrlText | undefined,
): URL | undefined {
  if (!urlOverride) return undefined;
  const override = new URL(urlOverride);
  if (!["http:", "https:"].includes(override.protocol))
    throw new Error("The URL override must use HTTP or HTTPS.");
  return override;
}

function applyOriginOverride(resolved: URL, override: URL): void {
  resolved.protocol = override.protocol;
  resolved.host = override.host;
  resolved.username = override.username;
  resolved.password = override.password;
}

/** @internal */
export async function closeQuietly(
  resource: { close(): Promise<void> } | undefined,
) {
  await resource?.close().catch(() => undefined);
}
