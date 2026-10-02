import { ProviderError, ProviderGate } from "@sedum-dev/core";
import { ClefAdapter } from "./index.js";

export type AuthProbeResult =
  "accepted" | "rejected" | "unreachable" | "unavailable";

/** One explicitly billable inference request, including response validation. */
export async function probeClefApiKey(
  apiKey: string,
  options: {
    accountId: string;
    model: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
  },
): Promise<AuthProbeResult> {
  const gate = new ProviderGate({ concurrency: 1 });
  try {
    const adapter = new ClefAdapter({
      accountId: options.accountId,
      apiKey,
      model: options.model,
      ...(options.fetch ? { fetch: options.fetch } : {}),
      attemptTimeoutMs: options.timeoutMs ?? 5_000,
      gate,
    });
    await adapter.holds(
      "The service is ready.",
      { complete: true, text: "The service is ready." },
      { maxAttempts: 1 },
    );
    return "accepted";
  } catch (error) {
    if (error instanceof ProviderError) {
      if (error.code === "authentication") return "rejected";
      if (error.code === "timeout" || error.code === "connection")
        return "unreachable";
    }
    return "unavailable";
  } finally {
    gate.close();
  }
}
