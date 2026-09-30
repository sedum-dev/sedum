import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import type {
  FlowDefinition,
  FlowDiagnostic,
  FlowSource,
  ParsedFlowResult,
} from "./flow-types.js";
import {
  parseFrame,
  scriptRegistry,
  sourceInFile,
  type ScriptRegistration,
  type TestBody,
} from "./script-registry.js";

export const SCRIPT_TEST_SUFFIX = ".test.ts";

export interface ScriptTest {
  readonly file: string;
  readonly title: string;
  readonly identity: string;
  readonly explicitId?: string;
  readonly url?: string;
  readonly tags: readonly string[];
  readonly body: TestBody;
  readonly source: FlowSource;
}

export interface LoadedScriptFile {
  readonly file: string;
  readonly tests: readonly ScriptTest[];
  readonly diagnostics: readonly FlowDiagnostic[];
}

export function isScriptTestFile(file: string): boolean {
  return file.endsWith(SCRIPT_TEST_SUFFIX);
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._/#:-]{0,199}$/u;
const TAG = /^[^\s,][^,]{0,119}$/u;
const OPTION_KEYS = new Set(["id", "url", "tags"]);

let jiti: ReturnType<typeof createJiti> | undefined;
const loaded = new Map<string, Promise<LoadedScriptFile>>();
let queue: Promise<unknown> = Promise.resolve();

function diagnostic(
  code: string,
  source: FlowSource,
  message: string,
  fix: string,
): FlowDiagnostic {
  return { severity: "error", code, source, message, fix };
}

/** Pure validation of what one file registered; exported for tests. */
export function checkRegistrations(
  file: string,
  registrations: readonly ScriptRegistration[],
  repoRoot: string,
): LoadedScriptFile {
  const relative = path.relative(repoRoot, file).split(path.sep).join("/");
  const top: FlowSource = { file, line: 1, col: 1 };
  const diagnostics: FlowDiagnostic[] = [];
  const tests: ScriptTest[] = [];
  const titles = new Map<string, FlowSource>();
  const ids = new Map<string, FlowSource>();
  if (registrations.length === 0)
    diagnostics.push(
      diagnostic(
        "no_tests",
        top,
        "This file declares no test.",
        'Call test("title", async ({ page, ai }) => { ... }) at the top level of the file.',
      ),
    );
  for (const registration of registrations) {
    const called = registration.callSite
      ? parseFrame(registration.callSite)
      : undefined;
    const source = called?.file === file ? called : top;
    const problems: FlowDiagnostic[] = [];
    const { title, options, body } = registration;
    if (typeof title !== "string" || !title.trim() || title.length > 512)
      problems.push(
        diagnostic(
          "invalid_title",
          source,
          "A test title must be a nonblank string of at most 512 characters.",
          'Write test("a customer signs in", ...).',
        ),
      );
    if (typeof body !== "function")
      problems.push(
        diagnostic(
          "missing_body",
          source,
          "This test has no body function.",
          "Pass an async function as the last argument to test().",
        ),
      );
    if (typeof options !== "object" || options === null)
      problems.push(
        diagnostic(
          "invalid_options",
          source,
          "Test options must be an object.",
          "Pass { url, id, tags } or omit the options.",
        ),
      );
    else {
      for (const key of Object.keys(options))
        if (!OPTION_KEYS.has(key))
          problems.push(
            diagnostic(
              "unknown_option",
              source,
              `Unknown test option \`${key}\`.`,
              "Use only `url`, `id`, and `tags`.",
            ),
          );
      if (
        options.id !== undefined &&
        (typeof options.id !== "string" || !ID.test(options.id))
      )
        problems.push(
          diagnostic(
            "invalid_id",
            source,
            "A test id uses letters, digits, and . _ / # : - (at most 200).",
            "Choose an id such as `checkout-new-user`.",
          ),
        );
      if (
        options.url !== undefined &&
        (typeof options.url !== "string" || !options.url.trim())
      )
        problems.push(
          diagnostic(
            "invalid_url",
            source,
            "The test url must be a nonblank string.",
            "Use an absolute URL, or a path relative to baseUrl.",
          ),
        );
      if (
        options.tags !== undefined &&
        (!Array.isArray(options.tags) ||
          options.tags.some((tag) => typeof tag !== "string" || !TAG.test(tag)))
      )
        problems.push(
          diagnostic(
            "invalid_tags",
            source,
            "Tags must be a list of nonblank strings without commas.",
            'Write tags: ["checkout", "smoke"].',
          ),
        );
    }
    if (problems.length) {
      diagnostics.push(...problems);
      continue;
    }
    const identity = options.id ?? `${relative}#${title}`;
    const earlierTitle = titles.get(title);
    if (earlierTitle) {
      diagnostics.push(
        diagnostic(
          "duplicate_title",
          source,
          `Duplicate test title ${JSON.stringify(title)}; first used on line ${earlierTitle.line}.`,
          "Give each test in a file its own title.",
        ),
      );
      continue;
    }
    titles.set(title, source);
    const earlierId = ids.get(identity);
    if (earlierId) {
      diagnostics.push(
        diagnostic(
          "duplicate_id",
          source,
          `Duplicate test id \`${identity}\`; first used on line ${earlierId.line}.`,
          "Give each test a unique id.",
        ),
      );
      continue;
    }
    ids.set(identity, source);
    tests.push({
      file,
      title,
      identity,
      ...(options.id === undefined ? {} : { explicitId: options.id }),
      ...(options.url === undefined ? {} : { url: options.url }),
      tags: [...(options.tags ?? [])],
      body,
      source,
    });
  }
  return { file, tests, diagnostics };
}

/**
 * `import ... from "sedum-cli"` in a test file resolves to the authoring API
 * of the CLI that is running it: a test works without a local install (for
 * example after `npx sedum init`), and never mixes two Sedum versions.
 */
function authoringEntry(): string {
  for (const name of ["./script-api.js", "./script-api.ts"]) {
    const candidate = fileURLToPath(new URL(name, import.meta.url));
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("The Sedum authoring API is missing from this install.");
}

async function importOnce(
  file: string,
  repoRoot: string,
): Promise<LoadedScriptFile> {
  jiti ??= createJiti(import.meta.url, {
    moduleCache: true,
    alias: { "sedum-cli": authoringEntry() },
  });
  const registry = scriptRegistry();
  registry.pending = [];
  try {
    await jiti.import(file);
  } catch (error) {
    registry.pending = [];
    const stack = error instanceof Error ? error.stack : undefined;
    const message =
      error instanceof Error ? error.message.split("\n")[0]! : String(error);
    return {
      file,
      tests: [],
      diagnostics: [
        diagnostic(
          "load_error",
          sourceInFile(stack, file) ?? { file, line: 1, col: 1 },
          `The test file could not be loaded: ${message.slice(0, 300)}`,
          "Fix the error, or check that its imports are installed.",
        ),
      ],
    };
  }
  const registrations = registry.pending;
  registry.pending = [];
  return checkRegistrations(file, registrations, repoRoot);
}

/**
 * Import a `*.test.ts` file once per process and collect its `test()` calls.
 * Imports run one at a time, because registration goes through one shared
 * list; the result is cached, as the module itself is.
 */
export function loadScriptFile(
  file: string,
  options: { readonly repoRoot: string },
): Promise<LoadedScriptFile> {
  const absolute = path.resolve(file);
  let pending = loaded.get(absolute);
  if (!pending) {
    pending = queue.then(() => importOnce(absolute, options.repoRoot));
    queue = pending.catch(() => undefined);
    loaded.set(absolute, pending);
  }
  return pending;
}

/**
 * Listing and selection work on flow headers; each script test becomes one
 * header whose identity selects it inside its file.
 */
export function scriptListingEntries(script: LoadedScriptFile): readonly {
  readonly file: string;
  readonly result: ParsedFlowResult;
}[] {
  const coverage = {
    format: "passed",
    steps: "not_checked",
    modules: "not_needed",
  } as const;
  // A file's own problems are one invalid entry beside its valid tests.
  const problems = script.diagnostics.length
    ? [
        {
          file: script.file,
          result: {
            diagnostics: script.diagnostics,
            coverage: { ...coverage, format: "failed" as const },
          },
        },
      ]
    : [];
  return [
    ...problems,
    ...script.tests.map((test) => {
      const header: FlowDefinition = {
        version: 1,
        file: test.file,
        identity: test.identity,
        ...(test.explicitId === undefined
          ? {}
          : { explicitId: test.explicitId, idSource: test.source }),
        description: test.title,
        ...(test.url === undefined ? {} : { url: test.url }),
        tags: test.tags,
        meta: {},
        data: {},
        before: [],
        steps: [],
        after: [],
      };
      return {
        file: test.file,
        result: { value: header, diagnostics: [], coverage },
      };
    }),
  ];
}
