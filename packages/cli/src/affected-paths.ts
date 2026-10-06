import { minimatch } from "minimatch";

export function validAffectedGlob(pattern: string): boolean {
  if (!pattern.trim()) return false;
  if (/^[/!]|^[A-Za-z]:|\\/u.test(pattern)) return false;
  if (pattern.split("/").includes("..")) return false;
  return balancedGlobDelimiters(pattern);
}

function balancedGlobDelimiters(pattern: string): boolean {
  const stack: string[] = [];
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!;
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing < 0) return false;
      index = closing;
      continue;
    }
    if ("{(".includes(character)) stack.push(character);
    const opening = { ")": "(", "}": "{" }[character];
    if (opening && stack.pop() !== opening) return false;
  }
  return stack.length === 0;
}

export function affectedPathIgnored(
  file: string,
  patterns: readonly string[],
): boolean {
  return patterns.some((pattern) =>
    minimatch(file, pattern.endsWith("/") ? `${pattern}**` : pattern, {
      dot: true,
      nonegate: true,
      nocomment: true,
    }),
  );
}
