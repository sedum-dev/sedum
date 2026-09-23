import {
  displayPath,
  NOT_CHECKED_OFFLINE_CODE,
  type DiscoveryProblem,
  type ProjectValidationResult,
  type TestListing,
} from "@sedum-dev/core";
import type { OutputCapabilities } from "./output.js";

const ansi = {
  red: "\u001b[31m",
  yellow: "\u001b[33m",
  green: "\u001b[32m",
  reset: "\u001b[0m",
};

function paint(
  value: string,
  color: "red" | "yellow" | "green",
  capabilities: OutputCapabilities,
): string {
  return capabilities.color ? `${ansi[color]}${value}${ansi.reset}` : value;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Diagnostics as `path:line:col: label: message` plus a fix, then a summary. */
export function renderValidation(
  result: ProjectValidationResult,
  root: string,
  capabilities: OutputCapabilities,
): string {
  const lines: string[] = [];
  for (const item of result.diagnostics) {
    const where = `${displayPath(root, item.source.file)}:${item.source.line}:${item.source.col}`;
    const label =
      item.severity === "warning"
        ? paint(`warning ${item.code}`, "yellow", capabilities)
        : item.code === NOT_CHECKED_OFFLINE_CODE
          ? paint("not checked offline", "yellow", capabilities)
          : paint(`error ${item.code}`, "red", capabilities);
    const fix =
      item.code === NOT_CHECKED_OFFLINE_CODE
        ? "Rephrase with a supported verb, or run `sedum validate --online` with TYPESAFE_API_KEY set and commit .sedum/classifications.json."
        : item.fix;
    lines.push(`${where}: ${label}: ${item.message}`, `  Fix: ${fix}`);
  }
  const { counts } = result;
  const checked = `Checked ${plural(counts.tests, "test")} and ${plural(counts.modules, "module")}`;
  const parts = [
    counts.errors ? plural(counts.errors, "error") : "",
    counts.warnings ? plural(counts.warnings, "warning") : "",
    counts.notCheckedOffline
      ? `${plural(counts.notCheckedOffline, "sentence")} not checked offline`
      : "",
  ].filter(Boolean);
  lines.push(
    parts.length
      ? `${checked}: ${parts.join(", ")}.`
      : `${checked}: ${paint("all valid", "green", capabilities)}.`,
  );
  if (counts.unreferencedModules)
    lines.push(
      `${plural(counts.unreferencedModules, "module")} not used by any test ${counts.unreferencedModules === 1 ? "was" : "were"} checked for format and ${counts.unreferencedModules === 1 ? "its" : "their"} own sentences only; module calls are checked through tests.`,
    );
  return `${lines.join("\n")}\n`;
}

export function renderProblems(problems: readonly DiscoveryProblem[]): string {
  return problems
    .map((problem) => `${problem.message}\nFix: ${problem.fix}\n`)
    .join("");
}

/** Aligned `ID  TAGS  PATH` rows; invalid files are reported separately. */
export function renderListTable(listing: TestListing): string {
  if (!listing.tests.length) return "No tests found.\n";
  const rows = [
    ["ID", "TAGS", "PATH"],
    ...listing.tests.map((test) => [
      test.id,
      test.tags.length ? test.tags.join(",") : "-",
      test.file,
    ]),
  ];
  const widths = [0, 1].map((column) =>
    Math.max(...rows.map((row) => row[column]!.length)),
  );
  const body = rows.map((row) =>
    [row[0]!.padEnd(widths[0]!), row[1]!.padEnd(widths[1]!), row[2]!].join(
      "  ",
    ),
  );
  return `${body.join("\n")}\n${plural(listing.tests.length, "test")}\n`;
}

export function renderListInvalid(listing: TestListing): string {
  return listing.invalid
    .map((entry) => {
      const first = entry.diagnostics[0];
      const detail = first
        ? `${entry.file}:${first.line}:${first.col}: ${first.severity} ${first.code}: ${first.message}`
        : `${entry.file}: could not be listed.`;
      return `${detail}\nRun \`sedum validate ${entry.file}\` for all problems.\n`;
    })
    .join("");
}

/** Stable, versioned machine output. Additive fields keep schemaVersion 1. */
export function renderListJson(listing: TestListing): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      tests: listing.tests.map((test) => ({
        id: test.id,
        idSource: test.idSource,
        file: test.file,
        description: test.description,
        tags: test.tags,
      })),
      invalid: listing.invalid.map((entry) => ({
        file: entry.file,
        diagnostics: entry.diagnostics.map((item) => ({
          severity: item.severity,
          code: item.code,
          line: item.line,
          col: item.col,
          message: item.message,
          fix: item.fix,
        })),
      })),
    },
    null,
    2,
  )}\n`;
}
