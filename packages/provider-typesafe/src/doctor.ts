import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  APIUserAbortError,
  TypeSafeClient,
  choice,
  type Fetch,
} from "@typesafe-ai/sdk";
import { MODEL } from "./request.js";

export type AuthProbeResult =
  "accepted" | "rejected" | "unreachable" | "unavailable";

/** One small, bounded, potentially billable request. Never return an SDK error body. */
export async function probeTypeSafeApiKey(
  apiKey: string,
  options: {
    fetch?: Fetch;
    timeoutMs?: number;
    baseURL?: string;
    model?: string;
  } = {},
): Promise<AuthProbeResult> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const model = options.model ?? MODEL;
  const client = new TypeSafeClient({
    apiKey,
    baseURL: options.baseURL ?? "https://api.typesafe.ai",
    defaultModel: model,
    logLevel: "off",
    timeout: timeoutMs,
    retry: { maxRetries: 0 },
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  try {
    await client.systemOne(
      {
        state: {},
        questions: {
          ready: choice("Select ready.", { ready: "Ready", other: "Other" }),
        },
        model,
      },
      { timeout: timeoutMs, retry: { maxRetries: 0 } },
    );
    return "accepted";
  } catch (error) {
    if (
      error instanceof APIError &&
      (error.status === 401 || error.status === 403)
    )
      return "rejected";
    if (
      error instanceof APIConnectionError ||
      error instanceof APITimeoutError ||
      error instanceof APIUserAbortError
    )
      return "unreachable";
    return "unavailable";
  }
}
