import { BrowserDriverError, ProviderError } from "@sedum-dev/core";

export interface CliDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly fix: string;
}

export interface CanonicalDiagnosticError {
  readonly code: string;
  readonly message: string;
}

export function setupDiagnostic(error: unknown): CliDiagnostic {
  if (error instanceof ProviderError && error.code === "configuration")
    return {
      code: "missing_key",
      message: "The TypeSafe provider is not configured.",
      fix: "Set TYPESAFE_API_KEY and rerun the command.",
    };
  if (error instanceof BrowserDriverError && error.code === "browser-missing")
    return {
      code: "browser_missing",
      message: "No supported browser binary was found.",
      fix: "Run `sedum browsers install chromium`, then rerun the test.",
    };
  return {
    code: "setup_or_output_error",
    message: "The run could not be prepared safely.",
    fix: "Check the test path, provider key, browser installation, and write access, then rerun.",
  };
}

export function outputDiagnostic(path: string): CliDiagnostic {
  return {
    code: "output_error",
    message: `The run result could not be written to ${path}.`,
    fix: "Make the .sedum output directory writable and rerun the command.",
  };
}

function bounded(value: string, maximum = 512): string {
  return [...value].slice(0, maximum).join("");
}

/** Keeps display-only details such as full paths out of the bounded artifact. */
export function canonicalDiagnosticError(
  diagnostic: CliDiagnostic,
): CanonicalDiagnosticError {
  return {
    code: diagnostic.code,
    message:
      diagnostic.code === "output_error"
        ? "The run result could not be written."
        : bounded(diagnostic.message),
  };
}

export function flowDiagnostic(result: {
  readonly code: string;
  readonly message: string;
  readonly fix?: string;
  readonly source?: {
    readonly file: string;
    readonly line: number;
    readonly col: number;
  };
}): CliDiagnostic {
  if (
    result.code === "invalid_test" ||
    result.code === "unsupported_test" ||
    result.code === "invalid_data"
  ) {
    const source = result.source
      ? `${result.source.file}:${result.source.line}:${result.source.col}: `
      : "";
    return {
      code: result.code,
      message: bounded(`${source}${result.message}`),
      fix: bounded(
        result.fix ?? "Fix the reported test input and rerun the command.",
      ),
    };
  }

  const known: Readonly<Record<string, Omit<CliDiagnostic, "code">>> = {
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
  const diagnostic = known[result.code];
  if (diagnostic) return { code: result.code, ...diagnostic };
  if (result.code.startsWith("provider_"))
    return {
      code: result.code,
      message: "The model provider could not complete the run safely.",
      fix:
        result.code === "provider_configuration" ||
        result.code === "provider_authentication"
          ? "Check TYPESAFE_API_KEY and provider access, then rerun the test."
          : "Check provider availability and the test input, then rerun the test.",
    };
  return {
    code: "execution_error",
    message: "The browser run could not be completed safely.",
    fix: "Check the browser, provider, and test input, then rerun the test.",
  };
}

export function renderDiagnostic(diagnostic: CliDiagnostic): string {
  return `${diagnostic.message}\nFix: ${diagnostic.fix}\n`;
}
