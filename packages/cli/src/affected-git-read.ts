import { spawn } from "node:child_process";
import { isUtf8 } from "node:buffer";

export const MAX_DIFF_BYTES = 16 * 1024 * 1024;
export class AffectedSelectionError extends Error {}

/** Bounded, shell-free Git reads. Never expose stderr or patch content in errors. */
export function gitRead(
  cwd: string,
  args: string[],
  signal?: AbortSignal,
  limit = MAX_DIFF_BYTES,
): Promise<string> {
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      ...(signal ? { signal } : {}),
    });
    const buffers: Buffer[] = [];
    let bytes = 0;
    let exceeded = false;
    child.stdout.on("data", (buffer: Buffer) => {
      bytes += buffer.length;
      if (bytes > limit) {
        exceeded = true;
        child.kill();
      } else buffers.push(buffer);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (exceeded)
        reject(
          new AffectedSelectionError(
            "Retained Git input exceeds the 16 MiB guard. Run the full suite; input was not truncated.",
          ),
        );
      else if (code !== 0) reject(new Error("Git read failed"));
      else resolve(Buffer.concat(buffers));
    });
  }).then(decodeGitOutput);
}

function decodeGitOutput(output: Buffer): string {
  if (!isUtf8(output))
    throw new AffectedSelectionError(
      "Git input is not valid UTF-8. Run the full suite.",
    );
  return output.toString("utf8");
}
