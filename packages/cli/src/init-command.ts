import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadProjectConfig, ProjectConfigError } from "./config.js";
import {
  browserAvailable,
  keyPresent,
  supportedNode,
} from "./doctor-command.js";

const CONFIG = `# Sedum starter project. See https://github.com/sedum-dev/sedum/blob/main/docs/configuration.md
tests:
  directory: tests
browser: chromium
outputDir: .sedum/runs
reporterDir: .sedum/reports
`;

const EXAMPLE = `description: Sign in to the SauceDemo sample store
url: https://www.saucedemo.com/
data:
  user: standard_user
  password: $SAUCE_PASSWORD
steps:
  - type {{user}} in the username field
  - type {{password}} in the password field
  - click the login button
  - verify a list of products with prices is shown
`;

const ENV_EXAMPLE = `# Get a TypeSafe key and put it in .env, or set it in your shell.
TYPESAFE_API_KEY=
# Public SauceDemo sample account; no Sauce Labs account is required.
SAUCE_PASSWORD=secret_sauce
`;

const IGNORE = [".env", ".sedum/runs/", ".sedum/reports/"] as const;

const WORDMARK = [
  "████ █████ ████  █   █ █   █",
  "█ ░░░░█░░░░░█░░░█ █░  █░██ ██░",
  " ███░░████░░█░░░█░█░░ █░█░█ █░░",
  "  ░░█ █░░░░ █░░ █░█░░ █░█░░░█░░",
  "████░░█████░████ ░░███ ░█░░ █░░",
  " ░░░░ ░░░░░░ ░░░░ ░ ░░░ ░░░  ░░",
  "  ░░░░  ░░░░░ ░░░░   ░░░  ░   ░",
] as const;

function initBanner(columns?: number): string {
  const green = "\u001b[32m";
  const shadow = "\u001b[90m";
  const reset = "\u001b[0m";
  if (columns !== undefined && columns < 36)
    return `${green}\u001b[1msedum${reset}\n\n`;

  return `${WORDMARK.map((line) => `${green}${line.replaceAll("░", `${shadow}░${green}`)}${reset}`).join("\n")}\n\n`;
}

export interface InitOptions {
  readonly cwd: string;
  readonly interactive: boolean;
  readonly color: boolean;
  readonly columns?: number;
  readonly confirm?: (question: string) => Promise<boolean>;
  readonly nodeVersion?: string;
  readonly browser?: (kind: "chrome" | "chromium") => boolean;
  readonly onOutput?: (text: string) => void;
}

export interface InitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function regularOrAbsent(file: string): Promise<boolean> {
  try {
    const info = await lstat(file);
    if (!info.isFile())
      throw new Error(
        `${path.basename(file)} exists but is not a regular file.`,
      );
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (code(error) === "ENOENT") return false;
    throw error;
  }
}

async function regularDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory);
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      `${path.basename(directory)} exists but is not a regular directory.`,
    );
}

async function createOrKeep(
  file: string,
  contents: string,
): Promise<"created" | "kept"> {
  try {
    await writeFile(file, contents, { flag: "wx", mode: 0o644 });
    return "created";
  } catch (error) {
    if (code(error) !== "EEXIST") throw error;
    await regularOrAbsent(file);
    return "kept";
  }
}

async function updateIgnore(
  root: string,
  options: InitOptions,
): Promise<string> {
  const file = path.join(root, ".gitignore");
  const exists = await regularOrAbsent(file);
  if (!exists) {
    const result = await createOrKeep(file, `${IGNORE.join("\n")}\n`);
    if (result === "created") return "created .gitignore\n";
  }
  const current = await readFile(file, "utf8");
  const present = new Set(current.split(/\r?\n/u).map((line) => line.trim()));
  const missing = IGNORE.filter((entry) => !present.has(entry));
  if (!missing.length) return "kept .gitignore (rules already present)\n";
  const question = `Add ${missing.join(", ")} to existing .gitignore?`;
  if (
    !options.interactive ||
    !options.confirm ||
    !(await options.confirm(question))
  )
    return `kept .gitignore; add these lines manually:\n${missing.map((line) => `  ${line}`).join("\n")}\n`;
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW,
  );
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(".gitignore changed into a nonregular file.");
    await handle.writeFile(
      `${current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`,
    );
  } finally {
    await handle.close();
  }
  return `updated .gitignore (${missing.join(", ")})\n`;
}

export async function executeInitCommand(
  options: InitOptions,
): Promise<InitResult> {
  const root = path.resolve(options.cwd);
  const output: string[] = [];
  const say = (value: string) => {
    output.push(value);
    options.onOutput?.(value);
  };
  try {
    let keptEnvExample = false;
    if (options.interactive && options.color) say(initBanner(options.columns));
    await regularDirectory(path.join(root, "tests"));
    for (const [name, contents] of [
      ["sedum.config.yaml", CONFIG],
      ["tests/example.test.yaml", EXAMPLE],
      [".env.example", ENV_EXAMPLE],
    ] as const) {
      const result = await createOrKeep(path.join(root, name), contents);
      if (name === ".env.example" && result === "kept") keptEnvExample = true;
      say(`${result} ${name}\n`);
    }
    say(await updateIgnore(root, options));

    say("\nNext steps:\n");
    if (!supportedNode(options.nodeVersion ?? process.versions.node))
      say("- Install Node 20.19.0 or newer.\n");
    const config = await loadProjectConfig(root);
    const hasBrowser = (options.browser ?? browserAvailable)(config.browser);
    if (!hasBrowser) {
      if (config.browser === "chromium") {
        say("- Install Chromium: sedum browsers install chromium\n");
        if (process.platform === "linux")
          say(
            "  Linux system libraries: sedum browsers install chromium --with-deps\n",
          );
      } else
        say(
          "- Install Chrome or run `sedum browsers install chromium`; check the configured browser.\n",
        );
    }
    const hasEnv = await pathExists(path.join(root, ".env"));
    if (!keyPresent(config)) {
      say(
        hasEnv
          ? "- Set TYPESAFE_API_KEY in the project-root .env or your shell.\n"
          : "- Run `cp .env.example .env`, then set TYPESAFE_API_KEY in .env (or set it in your shell).\n",
      );
    }
    if (keptEnvExample && config.variables.SAUCE_PASSWORD !== "secret_sauce") {
      const template = await readFile(path.join(root, ".env.example"), "utf8");
      if (
        hasEnv ||
        !/^SAUCE_PASSWORD[ \t]*=[ \t]*["']?secret_sauce["']?[ \t]*$/mu.test(
          template,
        )
      )
        say(
          "- The existing .env.example was kept. For the generated SauceDemo test, set SAUCE_PASSWORD=secret_sauce in .env or your shell.\n",
        );
    }
    say("- Validate: sedum validate\n");
    say("- Run: sedum run tests/example.test.yaml\n");
    say(
      "  Example target: https://www.saucedemo.com/ (public standard_user / secret_sauce).\n",
    );
    say(
      "  Running the example uses the TypeSafe API and may incur a charge.\n",
    );
    return { stdout: output.join(""), stderr: "", exitCode: 0 };
  } catch (error) {
    const message =
      error instanceof ProjectConfigError
        ? "sedum.config.yaml or .env could not be loaded. Run `sedum doctor` to inspect the project."
        : error instanceof Error
          ? error.message
          : "Unknown filesystem error.";
    return {
      stdout: output.join(""),
      stderr: `sedum init could not finish: ${message}\nFix: check the named path and permissions, then rerun sedum init. Existing files were kept.\n`,
      exitCode: 3,
    };
  }
}
