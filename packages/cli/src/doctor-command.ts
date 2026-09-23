import { lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { findBrowserExecutable, type BrowserKind } from "@sedum-dev/core";
import {
  probeTypeSafeApiKey,
  type AuthProbeResult,
} from "@sedum-dev/provider-typesafe";
import { loadProjectConfig, type ResolvedProjectConfig } from "./config.js";

export type DoctorCheckId =
  | "node"
  | "config"
  | "browser"
  | "api_network"
  | "api_key"
  | "api_auth"
  | "output";

export interface DoctorCheck {
  readonly id: DoctorCheckId;
  readonly status: "pass" | "fail";
  readonly message: string;
  readonly fix: string | null;
}

export interface DoctorResult {
  readonly schemaVersion: 1;
  readonly checks: readonly DoctorCheck[];
}

export interface DoctorProbes {
  readonly nodeVersion?: string;
  readonly loadConfig?: (cwd: string) => Promise<ResolvedProjectConfig>;
  readonly browser?: (kind: BrowserKind) => boolean;
  readonly network?: () => Promise<boolean>;
  readonly auth?: (apiKey: string) => Promise<AuthProbeResult>;
  readonly output?: (config: ResolvedProjectConfig) => Promise<void>;
}

const pass = (id: DoctorCheckId, message: string): DoctorCheck => ({
  id,
  status: "pass",
  message,
  fix: null,
});
const fail = (
  id: DoctorCheckId,
  message: string,
  fix: string,
): DoctorCheck => ({
  id,
  status: "fail",
  message,
  fix,
});

function supportedNode(version: string): boolean {
  const parts = version.split(".").map(Number);
  return (
    parts.length >= 3 &&
    parts.every(Number.isSafeInteger) &&
    (parts[0]! > 20 ||
      (parts[0] === 20 &&
        (parts[1]! > 19 || (parts[1] === 19 && parts[2]! >= 0))))
  );
}

async function networkReachable(): Promise<boolean> {
  try {
    // Any HTTP response proves DNS, TLS and HTTP reachability.
    await fetch("https://api.typesafe.ai/", {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
    return true;
  } catch {
    return false;
  }
}

/** Probe a real write while honoring the same path and symlink rules as ProgressWriter. */
export async function checkOutputWritable(
  config: ResolvedProjectConfig,
): Promise<void> {
  const root = path.resolve(config.projectRoot);
  const base = path.resolve(config.outputDir);
  const relative = path.relative(root, base);
  if (relative === ".." || relative.startsWith(`..${path.sep}`))
    throw new Error("output path escapes project root");
  const created: string[] = [];
  let temporary: string | undefined;
  try {
    let current = root;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        await mkdir(current, { mode: 0o700 });
        created.push(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("output path is not a regular directory");
    }
    temporary = await mkdtemp(path.join(base, ".doctor-"));
    await writeFile(path.join(temporary, "write-probe"), "ok", {
      flag: "wx",
      mode: 0o600,
    });
  } finally {
    if (temporary) await rm(temporary, { recursive: true, force: true });
    for (const directory of created.reverse()) {
      await rmdir(directory).catch(() => undefined);
    }
  }
}

export async function executeDoctorCommand(
  cwd: string,
  probes: DoctorProbes = {},
): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const version = probes.nodeVersion ?? process.versions.node;
  checks.push(
    supportedNode(version)
      ? pass("node", `Node ${version} meets the >=20.19.0 requirement.`)
      : fail(
          "node",
          `Node ${version} is too old or invalid.`,
          "Install Node 20.19.0 or newer.",
        ),
  );

  let config: ResolvedProjectConfig | null = null;
  try {
    config = await (probes.loadConfig ?? loadProjectConfig)(cwd);
    checks.push(pass("config", "Project configuration is valid."));
  } catch {
    checks.push(
      fail(
        "config",
        "Project configuration could not be loaded.",
        "Correct sedum.config.yaml or the project-root .env and check file permissions.",
      ),
    );
  }

  if (config) {
    try {
      const available = (
        probes.browser ?? ((kind) => findBrowserExecutable(kind) !== null)
      )(config.browser);
      checks.push(
        available
          ? pass("browser", `${config.browser} is available.`)
          : fail(
              "browser",
              `${config.browser} was not found.`,
              "Install Chrome or run `sedum browsers install chromium`; check the configured browser.",
            ),
      );
    } catch {
      checks.push(
        fail(
          "browser",
          "Browser availability could not be checked.",
          "Check the browser installation and retry.",
        ),
      );
    }
  } else {
    checks.push(
      fail(
        "browser",
        "Configured browser is unknown.",
        "Fix project configuration, then rerun doctor.",
      ),
    );
  }

  let network = false;
  try {
    network = await (probes.network ?? networkReachable)();
  } catch {
    network = false;
  }
  checks.push(
    network
      ? pass("api_network", "TypeSafe API is reachable.")
      : fail(
          "api_network",
          "TypeSafe API could not be reached.",
          "Check DNS, TLS, proxy, firewall, and access to https://api.typesafe.ai.",
        ),
  );

  const key = config?.apiKey?.trim();
  checks.push(
    !config
      ? fail(
          "api_key",
          "API key source could not be read.",
          "Fix project configuration, then rerun doctor.",
        )
      : key
        ? pass("api_key", "TYPESAFE_API_KEY is present.")
        : fail(
            "api_key",
            "TYPESAFE_API_KEY is missing.",
            "Set TYPESAFE_API_KEY in the process environment or project-root .env.",
          ),
  );

  if (!config)
    checks.push(
      fail(
        "api_auth",
        "API authentication could not be checked.",
        "Fix project configuration, then rerun doctor.",
      ),
    );
  else if (!key)
    checks.push(
      fail(
        "api_auth",
        "API authentication could not be checked without a key.",
        "Set TYPESAFE_API_KEY, then rerun doctor.",
      ),
    );
  else if (!network)
    checks.push(
      fail(
        "api_auth",
        "API authentication could not be checked without API access.",
        "Restore TypeSafe API network access, then rerun doctor.",
      ),
    );
  else {
    let result: AuthProbeResult;
    try {
      result = await (probes.auth ?? probeTypeSafeApiKey)(key);
    } catch {
      result = "unavailable";
    }
    checks.push(
      result === "accepted"
        ? pass("api_auth", "TypeSafe API accepted the key.")
        : result === "rejected"
          ? fail(
              "api_auth",
              "TypeSafe API rejected the key.",
              "Replace TYPESAFE_API_KEY with a valid key and rerun doctor.",
            )
          : result === "unreachable"
            ? fail(
                "api_auth",
                "Authenticated TypeSafe request could not reach the API.",
                "Check the API connection and retry.",
              )
            : fail(
                "api_auth",
                "TypeSafe could not complete the authentication probe.",
                "Check API availability and account access, then retry.",
              ),
    );
  }

  if (config) {
    try {
      await (probes.output ?? checkOutputWritable)(config);
      checks.push(pass("output", "Output directory is writable."));
    } catch {
      checks.push(
        fail(
          "output",
          "Output directory is not writable or safe.",
          "Choose a writable, non-symlinked outputDir inside the project root and check permissions.",
        ),
      );
    }
  } else {
    checks.push(
      fail(
        "output",
        "Configured output directory is unknown.",
        "Fix project configuration, then rerun doctor.",
      ),
    );
  }

  return { schemaVersion: 1, checks };
}

export function renderDoctorText(result: DoctorResult): string {
  return result.checks
    .map(
      (check) =>
        `${check.status === "pass" ? "PASS" : "FAIL"} ${check.id}: ${check.message}${check.fix ? `\n  Fix: ${check.fix}` : ""}\n`,
    )
    .join("");
}
