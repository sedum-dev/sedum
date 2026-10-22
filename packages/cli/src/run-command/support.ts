import { safeText, type UnattributedRejection } from "@sedum-dev/core";
import path from "node:path";
import type { ResolvedProjectConfig } from "../config.js";
import type { CliDiagnostic } from "../diagnostics.js";

/** `SEDUM_VERIFY_GRACE_MS` overrides the configured step timeout when valid. */
export function verifyGraceMs(
  value: string | undefined,
  configured = 5_000,
): number {
  if (value === undefined) return configured;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 120_000
    ? parsed
    : configured;
}

/** A run-level diagnostic for rejections that no running test owned. */
export function strayRejectionDiagnostic(
  strays: readonly UnattributedRejection[],
  config: ResolvedProjectConfig,
): CliDiagnostic {
  const stray = strays[0]!;
  const where = stray.source
    ? `${path.relative(config.projectRoot, stray.source.file).split(path.sep).join("/")}:${stray.source.line}: `
    : "";
  const message = safeDiscoveryText(stray.message, config);
  const more =
    strays.length > 1
      ? ` (${strays.length - 1} more rejected outside their tests; see the terminal.)`
      : "";
  if (stray.reason === "internal")
    return {
      code: "internal_rejection",
      message: `Sedum hit an unexpected error during the run: ${message}${more}`,
      fix: "Rerun the command; if it repeats, report it at https://github.com/sedum-dev/sedum/issues with the run's progress.json.",
    };
  const what = {
    finished: `a promise ${stray.test ? `\`${safeDiscoveryText(stray.test, config)}\`` : "a test"} did not await rejected after that test finished`,
    shared:
      "a promise nobody awaited rejected in lines several tests share, such as tests declared in a loop, so no test is blamed",
    outside:
      "a promise nobody awaited rejected outside any running test, so no test is blamed",
    unknown: "a promise nobody awaited rejected with a value that has no stack",
  }[stray.reason];
  return {
    code: "stray_rejection",
    message: `${where}${what}: ${message}${more}`,
    fix: "Add `await` before the page, expect, API, and ai calls the test starts.",
  };
}

export function safeDiscoveryText(
  value: string,
  config: ResolvedProjectConfig,
): string {
  const withoutUrls = value.replace(/https?:\/\/[^\s`"'<>]+/giu, "[URL]");
  return safeText(
    withoutUrls,
    {
      secretValues: [
        ...(config.credentialValues ?? []),
        ...Object.values(config.variables).filter(
          (entry): entry is string =>
            typeof entry === "string" && entry.length >= 4,
        ),
      ],
    },
    512,
  );
}
