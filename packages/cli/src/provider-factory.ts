import type {
  ClassificationProvider,
  GoalPlanner,
  Judge,
  RelevanceProvider,
  Resolver,
} from "@sedum-dev/core";
import { ProviderGate } from "@sedum-dev/core";
import type { ResolvedProjectConfig } from "./config.js";

export type { RelevanceTest, RelevanceProvider } from "@sedum-dev/core";

export type CliProvider = Resolver &
  Judge &
  ClassificationProvider &
  GoalPlanner &
  RelevanceProvider;

export async function createCliProvider(
  config: Pick<
    ResolvedProjectConfig,
    | "providerName"
    | "apiKey"
    | "cloudflareAccountId"
    | "providerModel"
    | "providerBaseUrl"
  >,
  options: { readonly concurrency?: number; readonly gate?: ProviderGate } = {},
): Promise<CliProvider> {
  const gate =
    options.gate ??
    new ProviderGate(
      options.concurrency === undefined
        ? {}
        : { concurrency: options.concurrency },
    );
  if (config.providerName === "clef") {
    const { ClefAdapter } = await import("@sedum-dev/provider-clef");
    return new ClefAdapter({
      accountId: config.cloudflareAccountId ?? "",
      apiKey: config.apiKey ?? "",
      model: config.providerModel,
      gate,
    });
  }
  const { TypeSafeAdapter } = await import("@sedum-dev/provider-typesafe");
  return new TypeSafeAdapter({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    baseURL: config.providerBaseUrl,
    model: config.providerModel,
    gate,
  });
}
