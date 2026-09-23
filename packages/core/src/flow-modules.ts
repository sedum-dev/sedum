import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parseModule } from "./flow-loader.js";
import type {
  FlowDiagnostic,
  FlowSource,
  FlowStep,
  ModuleBinding,
  ModuleStep,
  ParsedFlowResult,
  ParsedModuleResult,
} from "./flow-types.js";

export interface ResolveFlowModulesOptions {
  readonly repoRoot: string;
  readonly maxDepth?: number;
}

function compareDiagnostics(a: FlowDiagnostic, b: FlowDiagnostic): number {
  return (
    a.source.file.localeCompare(b.source.file) ||
    a.source.line - b.source.line ||
    a.source.col - b.source.col ||
    a.code.localeCompare(b.code)
  );
}

function error(
  diagnostics: FlowDiagnostic[],
  step: ModuleStep,
  code: string,
  message: string,
  fix: string,
): void {
  diagnostics.push({
    severity: "error",
    code,
    source: step.source,
    message,
    fix,
  });
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Resolve a complete immutable module graph before classification or launch. */
export async function resolveFlowModules(
  parsed: ParsedFlowResult,
  options: ResolveFlowModulesOptions,
): Promise<ParsedFlowResult> {
  const flow = parsed.value;
  if (!flow || parsed.coverage.modules === "not_needed") return parsed;
  const diagnostics = [...parsed.diagnostics];
  const maxDepth = options.maxDepth ?? 32;
  const root = await realpath(path.resolve(options.repoRoot)).catch(() =>
    path.resolve(options.repoRoot),
  );
  const displayRoot = path.resolve(options.repoRoot);
  const cache = new Map<string, ParsedModuleResult>();
  let occurrence = 0;

  const load = async (file: string): Promise<ParsedModuleResult> => {
    const cached = cache.get(file);
    if (cached) return cached;
    let result: ParsedModuleResult;
    try {
      const displayFile = path.join(displayRoot, path.relative(root, file));
      result = parseModule(await readFile(file, "utf8"), displayFile);
    } catch {
      result = {
        diagnostics: [
          {
            severity: "error",
            code: "unreadable_module",
            source: { file, line: 1, col: 1 },
            message: "Could not read this module file.",
            fix: "Check the module path and file permissions.",
          },
        ],
      };
    }
    cache.set(file, result);
    return result;
  };

  const expand = async (
    steps: readonly FlowStep[],
    ownerFile: string,
    phase: "before" | "steps" | "after",
    sourceStack: readonly FlowSource[],
    active: readonly string[],
    depth: number,
  ): Promise<readonly FlowStep[]> => {
    const expanded: FlowStep[] = [];
    for (const step of steps) {
      if (step.kind === "sentence") {
        expanded.push({
          ...step,
          phase,
          sourceStack: [...sourceStack, step.source],
        });
        continue;
      }
      const stack = [...sourceStack, step.source];
      if (depth > maxDepth) {
        error(
          diagnostics,
          step,
          "module_depth_exceeded",
          `Module nesting exceeds the ${maxDepth}-edge limit.`,
          "Split the module graph or reduce nested use calls.",
        );
        expanded.push({ ...step, phase, sourceStack: stack });
        continue;
      }
      const requested = path.resolve(path.dirname(ownerFile), step.use);
      let canonical: string;
      try {
        canonical = await realpath(requested);
      } catch {
        error(
          diagnostics,
          step,
          "unreadable_module",
          `Could not read module ${step.use}.`,
          "Check that the relative .module.yaml path exists and is readable.",
        );
        expanded.push({ ...step, phase, sourceStack: stack });
        continue;
      }
      if (!inside(root, canonical)) {
        error(
          diagnostics,
          step,
          "module_outside_repo",
          "The module resolves outside the repository root.",
          "Reference a .module.yaml file contained in this repository.",
        );
        expanded.push({ ...step, phase, sourceStack: stack });
        continue;
      }
      if (!canonical.endsWith(".module.yaml")) {
        error(
          diagnostics,
          step,
          "invalid_module_path",
          "The canonical target is not a .module.yaml file.",
          "Reference a module file with the .module.yaml suffix.",
        );
        expanded.push({ ...step, phase, sourceStack: stack });
        continue;
      }
      const cycleAt = active.indexOf(canonical);
      if (cycleAt >= 0) {
        const chain = [...active.slice(cycleAt), canonical]
          .map((item) => path.relative(root, item).replaceAll("\\", "/"))
          .join(" -> ");
        error(
          diagnostics,
          step,
          "module_cycle",
          `Module cycle detected: ${chain}.`,
          "Remove one use edge from the cycle.",
        );
        expanded.push({ ...step, phase, sourceStack: stack });
        continue;
      }
      const loaded = await load(canonical);
      diagnostics.push(...loaded.diagnostics);
      const module = loaded.value;
      if (!module) {
        expanded.push({ ...step, phase, sourceStack: stack });
        continue;
      }
      const declared = new Set(module.parameters);
      const supplied = Object.keys(step.with);
      for (const parameter of module.parameters)
        if (!Object.hasOwn(step.with, parameter))
          error(
            diagnostics,
            step,
            "missing_module_argument",
            `Module ${step.use} requires argument \`${parameter}\`.`,
            `Add \`${parameter}\` under with.`,
          );
      for (const argument of supplied)
        if (!declared.has(argument))
          diagnostics.push({
            severity: "error",
            code: "unknown_module_argument",
            source: step.withSources[argument] ?? step.source,
            message: `Module ${step.use} does not declare argument \`${argument}\`.`,
            fix: "Remove it or declare the parameter in the module.",
          });
      const bindings: Record<string, ModuleBinding> = Object.create(
        null,
      ) as Record<string, ModuleBinding>;
      for (const parameter of module.parameters)
        if (Object.hasOwn(step.with, parameter))
          bindings[parameter] = {
            value: step.with[parameter]!,
            source: step.withSources[parameter] ?? step.source,
          };
      const children = await expand(
        module.steps,
        module.file,
        phase,
        stack,
        [...active, canonical],
        depth + 1,
      );
      expanded.push({
        ...step,
        phase,
        sourceStack: stack,
        resolved: {
          id: `module:${++occurrence}`,
          file: canonical,
          parameters: [...module.parameters],
          bindings,
          steps: children,
        },
      });
    }
    return expanded;
  };

  const before = await expand(flow.before, flow.file, "before", [], [], 1);
  const steps = await expand(flow.steps, flow.file, "steps", [], [], 1);
  const after = await expand(flow.after, flow.file, "after", [], [], 1);
  diagnostics.sort(compareDiagnostics);
  const failed = diagnostics.some((item) => item.severity === "error");
  return {
    ...(failed ? {} : { value: { ...flow, before, steps, after } }),
    diagnostics,
    coverage: {
      format: failed ? "failed" : parsed.coverage.format,
      steps: "not_checked",
      modules: failed ? "incomplete" : "checked",
    },
  };
}
