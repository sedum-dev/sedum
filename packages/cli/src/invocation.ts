/**
 * How the user can run sedum again. The README installs it as a project
 * dependency, where a bare `sedum` is not on PATH; hints must then say
 * `npx sedum`. A global install, or a repository checkout, keeps `sedum`.
 */
export function sedumCommand(
  env: Readonly<Record<string, string | undefined>> = process.env,
  script: string = process.argv[1] ?? "",
): "sedum" | "npx sedum" {
  if (env.npm_command === "exec" || env.npm_lifecycle_event === "npx")
    return "npx sedum";
  return /[\\/]node_modules[\\/]/.test(script) ? "npx sedum" : "sedum";
}

const SUBCOMMAND =
  /(?<![\w./-]|npx )sedum (?=(?:run|browsers|doctor|validate|init|list)\b|--help\b|--version\b)/g;

/** Rewrite `sedum <subcommand>` hints in terminal text for this invocation. */
export function withCommand(text: string, command: string): string {
  return command === "sedum" ? text : text.replace(SUBCOMMAND, `${command} `);
}
