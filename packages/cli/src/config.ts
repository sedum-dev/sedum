import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { minimatch } from "minimatch";
import { isMap, LineCounter, parseDocument, visit, type Node } from "yaml";
import type { BrowserKind, VerifyPolicy } from "@sedum-dev/core";
import { validAffectedGlob } from "./affected-paths.js";

export const CONFIG_FILE = "sedum.config.yaml";

const integrationCredentials = [
  "TYPESAFE_API_KEY",
  "OPENROUTER_API_KEY",
  "OPEN_ROUTER_API_KEY",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_AUTH_TOKEN",
  "CLOUDFLARE_API_TOKEN",
  "SEDUM_UPLOAD_TOKEN",
  "SEDUM_READ_TOKEN",
];

function removeIntegrationCredentials(
  variables: Record<string, string | undefined>,
): void {
  for (const name of integrationCredentials) variables[name] = undefined;
}

export interface ConfigDiagnostic {
  readonly code: string;
  readonly file: string;
  readonly line: number;
  readonly col: number;
  readonly key: string;
  readonly message: string;
  readonly fix: string;
}

export class ProjectConfigError extends Error {
  constructor(readonly diagnostics: readonly ConfigDiagnostic[]) {
    super(diagnostics[0]?.message ?? "The Sedum configuration is invalid.");
    this.name = "ProjectConfigError";
  }
}

export interface ProjectConfigOverrides {
  readonly environment?: string;
  readonly browser?: BrowserKind;
  readonly viewport?: { readonly width?: number; readonly height?: number };
  readonly thresholds?: VerifyPolicy;
  readonly outputDir?: string;
  readonly reporterDir?: string;
  readonly baseUrl?: string;
  readonly vision?: {
    readonly enabled?: boolean;
  };
  readonly screenshots?: boolean;
}

export interface ResolvedProjectConfig {
  readonly projectRoot: string;
  readonly configPath: string | null;
  readonly environment: string | null;
  readonly testDirectory: string;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly affected: { readonly ignore: readonly string[] };
  readonly browser: BrowserKind;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly thresholds: Required<VerifyPolicy>;
  readonly outputDir: string;
  readonly reporterDir: string;
  readonly baseUrl: string | null;
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly providerName: "typesafe" | "clef" | "openrouter";
  readonly apiKey: string | undefined;
  readonly apiKeyEnv?: string;
  /** Integration secrets retained for redaction, never injected into tests. */
  readonly credentialValues?: readonly string[];
  readonly cloudflareAccountId: string | undefined;
  readonly providerBaseUrl: string;
  readonly providerModel: string;
  /** Ask the provider's image model about ambiguous or unmatched clicks. */
  readonly vision: { readonly enabled: boolean };
  /**
   * Send viewport screenshots to the provider (TypeSafe images preview): a
   * visual check of each model-resolved target, and the Judge's evidence.
   * On by default for the direct TypeSafe endpoint only.
   */
  readonly screenshots: boolean;
  /** How long a step waits for the page: a verify, a missing or busy target. */
  readonly stepTimeoutMs: number;
}

interface RawEnvironment {
  readonly baseUrl?: unknown;
  readonly variables?: unknown;
  readonly provider?: unknown;
  readonly stepTimeoutMs?: unknown;
}

interface RawConfig extends RawEnvironment {
  readonly tests?: unknown;
  readonly affected?: unknown;
  readonly browser?: unknown;
  readonly viewport?: unknown;
  readonly thresholds?: unknown;
  readonly outputDir?: unknown;
  readonly reporterDir?: unknown;
  readonly environment?: unknown;
  readonly environments?: unknown;
  readonly vision?: unknown;
  readonly provider?: unknown;
  readonly screenshots?: unknown;
}

const DEFAULTS = {
  testDirectory: "tests",
  include: ["**/*.test.ts", "**/*.test.yaml"],
  exclude: [] as string[],
  browser: "chrome" as BrowserKind,
  viewport: { width: 1280, height: 900 },
  thresholds: {
    minP: 0.75,
    band: 0.15,
    contradictionCutoff: 0.5,
  },
  outputDir: ".sedum/runs",
  reporterDir: ".sedum/reports",
  vision: { enabled: false },
  stepTimeoutMs: 5_000,
};

export const DEFAULT_PROVIDER_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_PROVIDER_MODEL = "jev-latest";

const allowed = {
  root: new Set([
    "tests",
    "affected",
    "browser",
    "viewport",
    "thresholds",
    "outputDir",
    "reporterDir",
    "baseUrl",
    "environment",
    "variables",
    "environments",
    "vision",
    "provider",
    "screenshots",
    "stepTimeoutMs",
  ]),
  tests: new Set(["directory", "include", "exclude"]),
  affected: new Set(["ignore"]),
  viewport: new Set(["width", "height"]),
  thresholds: new Set(["verify", "lowConfidenceBand", "contradiction"]),
  environment: new Set(["baseUrl", "variables", "provider", "stepTimeoutMs"]),
  vision: new Set(["enabled"]),
  provider: new Set(["name", "model", "apiKeyEnv"]),
};

function source(
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): Pick<ConfigDiagnostic, "file" | "line" | "col"> {
  const position = counter.linePos(node?.range?.[0] ?? 0);
  return { file, line: position.line, col: position.col };
}

function diagnostic(
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
  key: string,
  code: string,
  message: string,
  fix: string,
): void {
  diagnostics.push({
    code,
    ...source(file, counter, node),
    key,
    message,
    fix,
  });
}

/** Keys that once configured the OpenRouter vision resolver. */
const REMOVED_KEYS: Readonly<Record<string, string>> = {
  "vision.model":
    "Vision fallback now uses the TypeSafe provider's image model.",
  "vision.timeoutMs":
    "Vision fallback now uses the TypeSafe provider's request deadline.",
  "vision.apiKeyEnv":
    "Vision fallback now uses the TypeSafe provider's API key.",
};

/** The diagnostic code, message and fix for a key that is not allowed. */
function keyProblem(
  path: string,
  key: string,
  names: ReadonlySet<string>,
): readonly [string, string, string] | null {
  const removed = Object.hasOwn(REMOVED_KEYS, path)
    ? REMOVED_KEYS[path]
    : undefined;
  if (removed)
    return [
      "removed_config_key",
      `Configuration key \`${path}\` was removed. ${removed}`,
      `Delete \`${path}\` from ${CONFIG_FILE}.`,
    ];
  if (names.has(key)) return null;
  return [
    "unknown_config_key",
    `Unknown configuration key \`${path}\`.`,
    keyFix(key, names),
  ];
}

function mapUnknownKeys(
  value: unknown,
  names: ReadonlySet<string>,
  prefix: string,
  file: string,
  counter: LineCounter,
  diagnostics: ConfigDiagnostic[],
): void {
  if (!isMap(value)) return;
  for (const pair of value.items) {
    const key = String(pair.key);
    const path = prefix ? `${prefix}.${key}` : key;
    const problem = keyProblem(path, key, names);
    if (problem)
      diagnostic(
        diagnostics,
        file,
        counter,
        pair.key as Node,
        path,
        ...problem,
      );
  }
}

/** Edit distance, for a "did you mean" on a misspelt key. */
function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const saved = row[j]!;
      row[j] = Math.min(
        row[j]! + 1,
        row[j - 1]! + 1,
        previous + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      previous = saved;
    }
  }
  return row[right.length]!;
}

function keyFix(key: string, names: ReadonlySet<string>): string {
  const [closest] = [...names]
    .map((known) => ({ known, score: distance(key, known) }))
    .sort((a, b) => a.score - b.score || a.known.localeCompare(b.known));
  return closest && closest.score <= 2
    ? `Did you mean \`${closest.known}\`?`
    : "Remove the key or use one documented in docs/configuration.md.";
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function scalarVariables(
  value: unknown,
  key: string,
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value)) {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "invalid_config_type",
      `Configuration key \`${key}\` must be a mapping of scalar values.`,
      `Write \`${key}: { NAME: value }\`.`,
    );
    return {};
  }
  const result: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (integrationCredentials.includes(name)) {
      diagnostic(
        diagnostics,
        file,
        counter,
        node,
        `${key}.${name}`,
        "api_key_in_config",
        `${name} must not be stored in sedum.config.yaml.`,
        `Put ${name} in the project-root .env or invoking process environment.`,
      );
      continue;
    }
    if (item === null || ["string", "number", "boolean"].includes(typeof item))
      result[name] = item === null ? "" : String(item);
    else
      diagnostic(
        diagnostics,
        file,
        counter,
        node,
        `${key}.${name}`,
        "invalid_config_variable",
        `Configuration variable \`${key}.${name}\` must be a scalar.`,
        "Use text, a number, a boolean, or null.",
      );
  }
  return result;
}

function relativePath(
  root: string,
  value: unknown,
  fallback: string,
  key: string,
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): string {
  if (value === undefined) value = fallback;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    path.isAbsolute(value)
  ) {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "invalid_config_path",
      `Configuration key \`${key}\` must be a nonempty project-relative path.`,
      `Use a relative path such as \`${fallback}\`.`,
    );
    return path.resolve(root, fallback);
  }
  const resolved = path.resolve(root, value);
  const relation = path.relative(root, resolved);
  if (relation === ".." || relation.startsWith(`..${path.sep}`)) {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "config_path_escape",
      `Configuration key \`${key}\` escapes the project root.`,
      "Choose a path inside the project root.",
    );
    return path.resolve(root, fallback);
  }
  return resolved;
}

function probability(
  value: unknown,
  fallback: number,
  key: string,
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "invalid_config_probability",
      `Configuration key \`${key}\` must be a probability from 0 to 1.`,
      "Use a finite number such as 0.75.",
    );
    return fallback;
  }
  return value;
}

function positiveInteger(
  value: unknown,
  fallback: number,
  key: string,
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): number {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 16_384
  ) {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "invalid_config_dimension",
      `Configuration key \`${key}\` must be an integer from 1 to 16384.`,
      "Use a positive viewport size such as 1280.",
    );
    return fallback;
  }
  return value as number;
}

function validStepTimeout(value: unknown): value is number {
  if (!Number.isSafeInteger(value)) return false;
  return (value as number) >= 0 && (value as number) <= 120_000;
}

interface DiagnosticSink {
  readonly diagnostics: ConfigDiagnostic[];
  readonly file: string;
  readonly counter: LineCounter;
  readonly node: (key: string) => Node | null | undefined;
}

/** Report every invalid `stepTimeoutMs`, selected environment or not. */
function reportInvalidStepTimeouts(
  raw: RawConfig,
  environments: Record<string, unknown>,
  sink: DiagnosticSink,
): void {
  const layers: [string, unknown][] = [["stepTimeoutMs", raw.stepTimeoutMs]];
  for (const [name, value] of Object.entries(environments))
    if (object(value))
      layers.push([`environments.${name}.stepTimeoutMs`, value.stepTimeoutMs]);
  for (const [key, value] of layers) {
    if (value === undefined || validStepTimeout(value)) continue;
    diagnostic(
      sink.diagnostics,
      sink.file,
      sink.counter,
      sink.node(key),
      key,
      "invalid_config_step_timeout",
      `Configuration key \`${key}\` must be a whole number of milliseconds from 0 to 120000.`,
      "Use a value such as 30000 for 30 seconds, or 0 to judge each step once.",
    );
  }
}

/**
 * Check `stepTimeoutMs` in every environment, so a mistake in one that is not
 * selected still shows; the selected environment's value wins.
 */
function resolveStepTimeout(
  raw: RawConfig,
  environment: RawEnvironment,
  sink: DiagnosticSink,
): number {
  reportInvalidStepTimeouts(raw, environmentMap(raw), sink);
  return (
    [environment.stepTimeoutMs, raw.stepTimeoutMs].find(validStepTimeout) ??
    DEFAULTS.stepTimeoutMs
  );
}

function environmentMap(raw: RawConfig): Record<string, unknown> {
  return object(raw.environments) ? raw.environments : {};
}

function stringList(
  value: unknown,
  fallback: readonly string[],
  key: string,
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): string[] {
  if (value === undefined) return [...fallback];
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || !item)
  ) {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "invalid_config_globs",
      `Configuration key \`${key}\` must be a list of nonempty glob strings.`,
      `Write \`${key}: ["**/*.test.ts", "**/*.test.yaml"]\`.`,
    );
    return [...fallback];
  }
  for (const pattern of value) {
    if (path.isAbsolute(pattern) || pattern.split(/[\\/]/u).includes(".."))
      diagnostic(
        diagnostics,
        file,
        counter,
        node,
        key,
        "unsafe_config_glob",
        `Configuration key \`${key}\` contains a glob outside its test directory.`,
        "Use project-relative glob segments without `..`.",
      );
  }
  return [...value];
}

function absoluteUrl(
  value: unknown,
  key: string,
  diagnostics: ConfigDiagnostic[],
  file: string,
  counter: LineCounter,
  node: Node | null | undefined,
): string | null {
  if (value === undefined) return null;
  try {
    if (typeof value !== "string") throw new Error("not text");
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("unsupported protocol");
    return parsed.href;
  } catch {
    diagnostic(
      diagnostics,
      file,
      counter,
      node,
      key,
      "invalid_config_url",
      `Configuration key \`${key}\` must be an absolute HTTP(S) URL.`,
      "Use a URL such as `https://example.com/`.",
    );
    return null;
  }
}

async function findConfig(
  start: string,
): Promise<{ root: string; file: string | null }> {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, CONFIG_FILE);
    try {
      await readFile(candidate, "utf8");
      return { root: current, file: candidate };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ProjectConfigError([
          {
            code: "unreadable_config",
            file: candidate,
            line: 1,
            col: 1,
            key: "<file>",
            message: `Could not read ${CONFIG_FILE}.`,
            fix: "Check the file permissions and try again.",
          },
        ]);
    }
    const parent = path.dirname(current);
    if (parent === current) return { root: path.resolve(start), file: null };
    current = parent;
  }
}

/**
 * The project-root `.env` that `sedum run` reads, for a command that does not
 * load sedum.config.yaml. The root is the nearest directory with a config, or
 * `start` itself. A missing file is empty.
 */
export async function readProjectEnvironment(
  start: string,
): Promise<Record<string, string | undefined>> {
  const { root } = await findConfig(start);
  try {
    return parseEnv(await readFile(path.join(root, ".env"), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function freeze(config: ResolvedProjectConfig): ResolvedProjectConfig {
  Object.freeze(config.include);
  Object.freeze(config.exclude);
  Object.freeze(config.affected.ignore);
  Object.freeze(config.affected);
  Object.freeze(config.viewport);
  Object.freeze(config.thresholds);
  Object.freeze(config.vision);
  Object.freeze(config.variables);
  Object.freeze(config.credentialValues);
  return Object.freeze(config);
}

export interface ProjectConfigLoadOptions {
  /**
   * False for commands that must not touch secrets (`validate`, `list`): the
   * project `.env` is not read, so `apiKey` comes only from `hostEnvironment`.
   */
  readonly readEnvironmentFile?: boolean;
}

type ConfigDocument = ReturnType<typeof parseDocument>;

/** Parse the YAML safely and flag keys Sedum does not know. */
async function readConfigDocument(
  file: string,
  counter: LineCounter,
  diagnostics: ConfigDiagnostic[],
): Promise<{ raw: RawConfig; document: ConfigDocument }> {
  let raw: RawConfig = {};
  const contents = await readFile(file, "utf8");
  const document = parseDocument(contents, {
    lineCounter: counter,
    strict: true,
    uniqueKeys: true,
  });
  for (const error of document.errors)
    diagnostic(
      diagnostics,
      file,
      counter,
      undefined,
      "<yaml>",
      "invalid_config_yaml",
      `Could not parse ${CONFIG_FILE}: ${error.message}`,
      "Correct the YAML syntax and duplicate keys.",
    );
  let unsafeYaml = false;
  visit(document, {
    Alias(_key, alias) {
      unsafeYaml = true;
      diagnostic(
        diagnostics,
        file,
        counter,
        alias,
        "<yaml>",
        "unsupported_config_alias",
        "YAML aliases are not supported in sedum.config.yaml.",
        "Write the value explicitly instead of using an anchor or alias.",
      );
    },
    Node(_key, value) {
      if ("tag" in value && value.tag) {
        unsafeYaml = true;
        diagnostic(
          diagnostics,
          file,
          counter,
          value,
          "<yaml>",
          "unsupported_config_tag",
          "YAML tags are not supported in sedum.config.yaml.",
          "Use ordinary YAML scalar, mapping, and sequence values.",
        );
      }
    },
  });
  let value: unknown = {};
  if (!unsafeYaml)
    try {
      value = document.toJS({ maxAliasCount: 0 }) as unknown;
    } catch {
      diagnostic(
        diagnostics,
        file,
        counter,
        document.contents as Node,
        "<yaml>",
        "invalid_config_yaml",
        `Could not safely decode ${CONFIG_FILE}.`,
        "Remove aliases, tags, or recursive YAML structures.",
      );
    }
  if (value !== null && !object(value))
    diagnostic(
      diagnostics,
      file,
      counter,
      document.contents as Node,
      "<root>",
      "invalid_config_root",
      `${CONFIG_FILE} must contain a YAML mapping.`,
      "Write configuration as key/value pairs.",
    );
  else raw = (value ?? {}) as RawConfig;
  mapUnknownKeys(
    document.contents,
    allowed.root,
    "",
    file,
    counter,
    diagnostics,
  );
  const maps = [
    ["tests", allowed.tests],
    ["affected", allowed.affected],
    ["viewport", allowed.viewport],
    ["thresholds", allowed.thresholds],
    ["vision", allowed.vision],
    ["provider", allowed.provider],
  ] as const;
  for (const [key, names] of maps)
    mapUnknownKeys(
      document.get(key, true),
      names,
      key,
      file,
      counter,
      diagnostics,
    );
  const environmentNode = document.get("environments", true);
  if (isMap(environmentNode))
    for (const pair of environmentNode.items)
      mapUnknownKeys(
        pair.value,
        allowed.environment,
        `environments.${String(pair.key)}`,
        file,
        counter,
        diagnostics,
      );
  return { raw, document };
}

export async function loadProjectConfig(
  start = process.cwd(),
  hostEnvironment: Readonly<Record<string, string | undefined>> = process.env,
  overrides: ProjectConfigOverrides = {},
  loadOptions: ProjectConfigLoadOptions = {},
): Promise<ResolvedProjectConfig> {
  const found = await findConfig(start);
  const file = found.file ?? path.join(found.root, CONFIG_FILE);
  const counter = new LineCounter();
  const diagnostics: ConfigDiagnostic[] = [];
  const { raw, document } = found.file
    ? await readConfigDocument(found.file, counter, diagnostics)
    : { raw: {} as RawConfig, document: null };
  const node = (key: string): Node | null | undefined =>
    document?.getIn(key.split("."), true) as Node | null | undefined;
  const tests = object(raw.tests) ? raw.tests : {};
  if (raw.tests !== undefined && !object(raw.tests))
    diagnostic(
      diagnostics,
      file,
      counter,
      node("tests"),
      "tests",
      "invalid_config_type",
      "Configuration key `tests` must be a mapping.",
      "Use `tests: { directory: tests }`.",
    );
  for (const [key, value] of [
    ["affected", raw.affected],
    ["viewport", raw.viewport],
    ["thresholds", raw.thresholds],
    ["environments", raw.environments],
    ["vision", raw.vision],
    ["provider", raw.provider],
  ] as const)
    if (value !== undefined && !object(value))
      diagnostic(
        diagnostics,
        file,
        counter,
        node(key),
        key,
        "invalid_config_type",
        `Configuration key \`${key}\` must be a mapping.`,
        `Write \`${key}: {}\` and add its documented child keys.`,
      );
  const viewport = object(raw.viewport) ? raw.viewport : {};
  const affected = object(raw.affected) ? raw.affected : {};
  const affectedIgnore = stringList(
    affected.ignore,
    [],
    "affected.ignore",
    diagnostics,
    file,
    counter,
    node("affected.ignore"),
  );
  if (affectedIgnore.some((glob) => !validAffectedGlob(glob)))
    diagnostic(
      diagnostics,
      file,
      counter,
      node("affected.ignore"),
      "affected.ignore",
      "invalid_affected_glob",
      "Affected ignores must be valid repository-relative POSIX globs.",
      "Use patterns such as `docs/` or `**/*.lock`.",
    );
  const thresholds = object(raw.thresholds) ? raw.thresholds : {};
  const environments = object(raw.environments) ? raw.environments : {};
  const vision = object(raw.vision) ? raw.vision : {};
  const provider = object(raw.provider) ? raw.provider : {};
  const credentialSettings = [["provider", provider]] as [
    string,
    Record<string, unknown>,
  ][];
  for (const [name, value] of Object.entries(environments)) {
    if (!object(value)) {
      diagnostic(
        diagnostics,
        file,
        counter,
        node(`environments.${name}`),
        `environments.${name}`,
        "invalid_config_environment",
        `Environment \`${name}\` must be a mapping.`,
        `Write \`environments.${name}: { baseUrl: https://example.com/ }\`.`,
      );
      continue;
    }
    const key = `environments.${name}.provider`;
    const settings = value.provider;
    mapUnknownKeys(
      node(key),
      new Set(["apiKeyEnv"]),
      key,
      file,
      counter,
      diagnostics,
    );
    if (settings !== undefined && !object(settings))
      diagnostic(
        diagnostics,
        file,
        counter,
        node(key),
        key,
        "invalid_config_type",
        `Configuration key \`${key}\` must be a mapping.`,
        `Write \`${key}: { apiKeyEnv: MY_API_KEY }\`.`,
      );
    if (object(settings)) credentialSettings.push([key, settings]);
    scalarVariables(
      value.variables,
      `environments.${name}.variables`,
      diagnostics,
      file,
      counter,
      node(`environments.${name}.variables`),
    );
  }
  const selectedValue = overrides.environment ?? raw.environment;
  const selected = selectedValue === undefined ? null : selectedValue;
  if (selected !== null && (typeof selected !== "string" || !selected))
    diagnostic(
      diagnostics,
      file,
      counter,
      node("environment"),
      "environment",
      "invalid_config_environment",
      "Configuration key `environment` must name an environment.",
      "Use a nonempty name declared under `environments`.",
    );
  const selectedRaw =
    typeof selected === "string" ? environments[selected] : undefined;
  if (typeof selected === "string" && !object(selectedRaw))
    diagnostic(
      diagnostics,
      file,
      counter,
      node("environment"),
      "environment",
      "unknown_config_environment",
      `Environment \`${selected}\` is not declared.`,
      `Add \`environments.${selected}\` or choose an existing environment.`,
    );
  const environment = object(selectedRaw)
    ? (selectedRaw as RawEnvironment)
    : {};
  for (const [prefix, settings] of credentialSettings) {
    const value = settings.apiKeyEnv;
    if (
      value !== undefined &&
      (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    )
      diagnostic(
        diagnostics,
        file,
        counter,
        node(`${prefix}.apiKeyEnv`),
        `${prefix}.apiKeyEnv`,
        "invalid_config_env_name",
        `Configuration key \`${prefix}.apiKeyEnv\` must be a valid environment variable name.`,
        "Use letters, digits, and underscores, starting with a letter or underscore.",
      );
  }
  const selectedProvider = object(environment.provider)
    ? environment.provider
    : {};
  const apiKeyEnv = selectedProvider.apiKeyEnv ?? provider.apiKeyEnv;

  const browserValue = overrides.browser ?? raw.browser ?? DEFAULTS.browser;
  const browser =
    browserValue === "chrome" || browserValue === "chromium"
      ? browserValue
      : DEFAULTS.browser;
  if (browserValue !== "chrome" && browserValue !== "chromium")
    diagnostic(
      diagnostics,
      file,
      counter,
      node("browser"),
      "browser",
      "invalid_config_browser",
      "Configuration key `browser` must be `chrome` or `chromium`.",
      "Choose one of the supported browser names.",
    );

  const verify = probability(
    overrides.thresholds?.minP ?? thresholds.verify,
    DEFAULTS.thresholds.minP,
    "thresholds.verify",
    diagnostics,
    file,
    counter,
    node("thresholds.verify"),
  );
  const band = probability(
    overrides.thresholds?.band ?? thresholds.lowConfidenceBand,
    DEFAULTS.thresholds.band,
    "thresholds.lowConfidenceBand",
    diagnostics,
    file,
    counter,
    node("thresholds.lowConfidenceBand"),
  );
  const contradictionCutoff = probability(
    overrides.thresholds?.contradictionCutoff ?? thresholds.contradiction,
    DEFAULTS.thresholds.contradictionCutoff,
    "thresholds.contradiction",
    diagnostics,
    file,
    counter,
    node("thresholds.contradiction"),
  );
  if (band > verify)
    diagnostic(
      diagnostics,
      file,
      counter,
      node("thresholds.lowConfidenceBand"),
      "thresholds.lowConfidenceBand",
      "invalid_threshold_policy",
      "The low-confidence band cannot exceed the verify threshold.",
      "Lower `lowConfidenceBand` or raise `verify`.",
    );

  const baseUrl = absoluteUrl(
    overrides.baseUrl ?? environment.baseUrl ?? raw.baseUrl,
    environment.baseUrl !== undefined
      ? `environments.${String(selected)}.baseUrl`
      : "baseUrl",
    diagnostics,
    file,
    counter,
    node(
      environment.baseUrl !== undefined
        ? `environments.${String(selected)}.baseUrl`
        : "baseUrl",
    ),
  );
  const rootVariables = scalarVariables(
    raw.variables,
    "variables",
    diagnostics,
    file,
    counter,
    node("variables"),
  );
  const selectedVariables = scalarVariables(
    environment.variables,
    `environments.${String(selected)}.variables`,
    diagnostics,
    file,
    counter,
    node(`environments.${String(selected)}.variables`),
  );

  let fileEnvironment: Record<string, string | undefined> = {};
  const environmentFile = path.join(found.root, ".env");
  try {
    if (loadOptions.readEnvironmentFile !== false)
      fileEnvironment = await readProjectEnvironment(found.root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      diagnostic(
        diagnostics,
        environmentFile,
        counter,
        undefined,
        "<file>",
        "invalid_env_file",
        "Could not read or parse the project-root .env file.",
        "Correct its dotenv syntax and permissions, or remove it.",
      );
  }

  const include = stringList(
    tests.include,
    DEFAULTS.include,
    "tests.include",
    diagnostics,
    file,
    counter,
    node("tests.include"),
  );
  const exclude = stringList(
    tests.exclude,
    DEFAULTS.exclude,
    "tests.exclude",
    diagnostics,
    file,
    counter,
    node("tests.exclude"),
  );
  if (include.length === 0)
    diagnostic(
      diagnostics,
      file,
      counter,
      node("tests.include"),
      "tests.include",
      "empty_config_globs",
      "Configuration key `tests.include` must select at least one pattern.",
      "Add `**/*.test.ts` or another test glob.",
    );
  const variables = {
    ...rootVariables,
    ...selectedVariables,
    ...fileEnvironment,
    ...hostEnvironment,
  };
  const providerEnvironment = new Map([
    ...Object.entries(fileEnvironment),
    ...Object.entries(hostEnvironment).filter(([, value]) => value?.trim()),
  ]);
  const providerValue = (name: string): string | undefined =>
    providerEnvironment.get(name)?.trim() || undefined;
  const cloudflareTokenFrom = (
    environment: Readonly<Record<string, string | undefined>>,
  ): string | undefined => {
    const authToken = environment.CLOUDFLARE_AUTH_TOKEN?.trim();
    const apiToken = environment.CLOUDFLARE_API_TOKEN?.trim();
    if (authToken && apiToken && authToken !== apiToken)
      diagnostics.push({
        code: "conflicting_cloudflare_api_tokens",
        file: environmentFile,
        line: 1,
        col: 1,
        key: "CLOUDFLARE_AUTH_TOKEN",
        message:
          "CLOUDFLARE_AUTH_TOKEN and CLOUDFLARE_API_TOKEN contain different values at the same precedence level.",
        fix: "Keep one token variable, or set both names to the same Workers AI API token.",
      });
    return authToken || apiToken || undefined;
  };
  const providerNameValue = provider.name ?? "typesafe";
  const providerName =
    providerNameValue === "typesafe" ||
    providerNameValue === "clef" ||
    providerNameValue === "openrouter"
      ? providerNameValue
      : "typesafe";
  if (providerName !== providerNameValue)
    diagnostic(
      diagnostics,
      file,
      counter,
      node("provider.name"),
      "provider.name",
      "invalid_config_provider",
      "Configuration key `provider.name` must be `typesafe`, `clef`, or `openrouter`.",
      "Choose one of the supported provider names.",
    );
  const configuredModel = provider.model;
  const validClefModel =
    configuredModel === "clef" || configuredModel === "clef-flash";
  if (
    configuredModel !== undefined &&
    (typeof configuredModel !== "string" ||
      !configuredModel.trim() ||
      (providerName === "clef" && !validClefModel))
  )
    diagnostic(
      diagnostics,
      file,
      counter,
      node("provider.model"),
      "provider.model",
      "invalid_config_provider_model",
      providerName === "clef"
        ? "Clef provider model must be `clef` or `clef-flash`."
        : "Provider model must be nonempty text.",
      providerName === "clef"
        ? "Use `provider.model: clef`."
        : "Use a nonempty model name.",
    );
  const customProvider = {
    baseUrl: providerValue("TYPESAFE_BASE_URL"),
    model: providerValue("TYPESAFE_DEFAULT_MODEL"),
  };
  let providerBaseUrl =
    providerName === "openrouter"
      ? "https://openrouter.ai/api"
      : DEFAULT_PROVIDER_BASE_URL;
  if (providerName === "typesafe" && customProvider.baseUrl) {
    try {
      const parsed = new URL(customProvider.baseUrl);
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("unsafe provider URL");
      providerBaseUrl = parsed.href.replace(/\/$/u, "");
    } catch {
      diagnostics.push({
        code: "invalid_provider_url",
        file: environmentFile,
        line: 1,
        col: 1,
        key: "TYPESAFE_BASE_URL",
        message:
          "TYPESAFE_BASE_URL must be an absolute HTTPS URL without credentials, query, or fragment.",
        fix: "Use a base URL such as https://api.typesafe.ai.",
      });
    }
  }
  const providerModel =
    providerName === "clef"
      ? typeof configuredModel === "string" && validClefModel
        ? configuredModel
        : "clef"
      : typeof configuredModel === "string" && configuredModel.trim()
        ? configuredModel.trim()
        : providerName === "openrouter"
          ? "typesafe/jev-1.13"
          : (customProvider.model ?? DEFAULT_PROVIDER_MODEL);
  const openRouterKeyFrom = (
    environment: Readonly<Record<string, string | undefined>>,
  ): string | undefined =>
    environment.OPENROUTER_API_KEY?.trim() ||
    environment.OPEN_ROUTER_API_KEY?.trim() ||
    undefined;
  const openRouterKey =
    openRouterKeyFrom(hostEnvironment) ?? openRouterKeyFrom(fileEnvironment);
  const apiKey =
    typeof apiKeyEnv === "string"
      ? providerValue(apiKeyEnv)
      : providerName === "clef"
        ? (cloudflareTokenFrom(hostEnvironment) ??
          cloudflareTokenFrom(fileEnvironment))
        : providerName === "openrouter"
          ? openRouterKey
          : providerValue("TYPESAFE_API_KEY");
  const cloudflareAccountId =
    providerName === "clef"
      ? providerValue("CLOUDFLARE_ACCOUNT_ID")
      : undefined;
  if (
    providerName === "clef" &&
    cloudflareAccountId !== undefined &&
    !/^[a-f\d]{32}$/iu.test(cloudflareAccountId)
  )
    diagnostics.push({
      code: "invalid_cloudflare_account_id",
      file: environmentFile,
      line: 1,
      col: 1,
      key: "CLOUDFLARE_ACCOUNT_ID",
      message:
        "CLOUDFLARE_ACCOUNT_ID must be exactly 32 hexadecimal characters.",
      fix: "Copy the account ID from the Cloudflare dashboard.",
    });
  const credentialValues = [apiKey].filter((value) => value !== undefined);
  for (const [, settings] of credentialSettings) {
    if (typeof settings.apiKeyEnv !== "string") continue;
    const name = settings.apiKeyEnv;
    for (const source of [hostEnvironment, fileEnvironment]) {
      const value = Object.hasOwn(source, name) ? source[name] : undefined;
      if (value?.trim()) credentialValues.push(value, value.trim());
    }
    variables[name] = undefined;
    for (const [prefix, values] of [
      ["variables", rootVariables],
      ...Object.entries(environments)
        .filter(([, value]) => object(value))
        .map(
          ([key, value]) =>
            [
              `environments.${key}.variables`,
              (value as RawEnvironment).variables,
            ] as const,
        ),
    ] as const) {
      if (object(values) && Object.hasOwn(values, name))
        diagnostic(
          diagnostics,
          file,
          counter,
          node(prefix),
          `${prefix}.${name}`,
          "api_key_in_config",
          `${name} must not be stored in sedum.config.yaml.`,
          `Put ${name} in the project-root .env or invoking process environment.`,
        );
    }
  }
  // Credentials configure integrations; they are not test variables and must
  // not be forwarded through the flow environment.
  removeIntegrationCredentials(variables);
  const visionEnabledValue = overrides.vision?.enabled ?? vision.enabled;
  const visionEnabled = visionEnabledValue ?? DEFAULTS.vision.enabled;
  if (typeof visionEnabled !== "boolean")
    diagnostic(
      diagnostics,
      file,
      counter,
      node("vision.enabled"),
      "vision.enabled",
      "invalid_config_type",
      "Configuration key `vision.enabled` must be a boolean.",
      "Use `vision.enabled: true` or `vision.enabled: false`.",
    );
  const screenshotsValue = overrides.screenshots ?? raw.screenshots;
  if (screenshotsValue !== undefined && typeof screenshotsValue !== "boolean")
    diagnostic(
      diagnostics,
      file,
      counter,
      node("screenshots"),
      "screenshots",
      "invalid_config_type",
      "Configuration key `screenshots` must be a boolean.",
      "Use `screenshots: true` or `screenshots: false`.",
    );
  // Gateways and compatible services may not accept the images preview.
  const screenshots =
    typeof screenshotsValue === "boolean"
      ? screenshotsValue
      : providerName === "typesafe" &&
        providerBaseUrl === DEFAULT_PROVIDER_BASE_URL;
  const testDirectory = relativePath(
    found.root,
    tests.directory,
    DEFAULTS.testDirectory,
    "tests.directory",
    diagnostics,
    file,
    counter,
    node("tests.directory"),
  );
  const outputDir = relativePath(
    found.root,
    overrides.outputDir ?? raw.outputDir,
    DEFAULTS.outputDir,
    "outputDir",
    diagnostics,
    file,
    counter,
    node("outputDir"),
  );
  const reporterDir = relativePath(
    found.root,
    overrides.reporterDir ?? raw.reporterDir,
    DEFAULTS.reporterDir,
    "reporterDir",
    diagnostics,
    file,
    counter,
    node("reporterDir"),
  );
  const width = positiveInteger(
    overrides.viewport?.width ?? viewport.width,
    DEFAULTS.viewport.width,
    "viewport.width",
    diagnostics,
    file,
    counter,
    node("viewport.width"),
  );
  const height = positiveInteger(
    overrides.viewport?.height ?? viewport.height,
    DEFAULTS.viewport.height,
    "viewport.height",
    diagnostics,
    file,
    counter,
    node("viewport.height"),
  );
  const sink = { diagnostics, file, counter, node };
  const stepTimeoutMs = resolveStepTimeout(raw, environment, sink);
  if (diagnostics.length) throw new ProjectConfigError(diagnostics);

  return freeze({
    projectRoot: found.root,
    configPath: found.file,
    environment: typeof selected === "string" ? selected : null,
    testDirectory,
    include,
    exclude,
    affected: { ignore: affectedIgnore },
    browser,
    viewport: { width, height },
    thresholds: { minP: verify, band, contradictionCutoff },
    outputDir,
    reporterDir,
    baseUrl,
    variables,
    providerName,
    apiKey,
    credentialValues,
    ...(typeof apiKeyEnv === "string" ? { apiKeyEnv } : {}),
    cloudflareAccountId,
    providerBaseUrl,
    providerModel,
    vision: { enabled: visionEnabled === true },
    screenshots: screenshots && providerName !== "clef",
    stepTimeoutMs,
  });
}

export async function discoverConfiguredTests(
  config: ResolvedProjectConfig,
): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const relative = path
          .relative(config.testDirectory, absolute)
          .split(path.sep)
          .join("/");
        if (
          (relative.endsWith(".test.ts") || relative.endsWith(".test.yaml")) &&
          config.include.some((pattern) => minimatch(relative, pattern)) &&
          !config.exclude.some((pattern) => minimatch(relative, pattern))
        )
          files.push(absolute);
      }
    }
  }
  await visit(config.testDirectory);
  return files.sort((left, right) => left.localeCompare(right));
}
