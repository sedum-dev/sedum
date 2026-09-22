import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TypeSafeAdapter } from "./index.js";
import { FixtureReplies } from "./fixture-replies.js";
import { buildResolverRequest } from "./request.js";

const folders: string[] = [];
async function cassette(entries: unknown[] = []) {
  const folder = await mkdtemp(join(tmpdir(), "sedum-replies-"));
  folders.push(folder);
  const path = join(folder, "replies.json");
  await writeFile(path, JSON.stringify({ version: 1, entries }));
  return { path, replies: await FixtureReplies.load(path) };
}
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    folders
      .splice(0)
      .map((folder) => rm(folder, { recursive: true, force: true })),
  );
});

const options = (id: string) => ({
  complete: true,
  options: [
    {
      kind: "candidate" as const,
      candidate: {
        id,
        tag: "button",
        role: "button",
        name: "Save",
        peers: [],
        editable: false,
        disabled: false,
      },
    },
    { kind: "none" as const, id: "none" as const },
  ],
});

describe("fixture reply transport", () => {
  it("reports an unmatched prompt through the harness after the SDK wraps it", async () => {
    const { replies } = await cassette();
    const adapter = new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: replies.fetch,
    });
    await expect(
      adapter.choose("Click Save", options("random-a")),
    ).rejects.toMatchObject({
      code: "invalid-input",
    });
    expect(replies.missing).toHaveLength(1);
    expect(replies.missing[0]).toMatch(/^[0-9a-f]{64}$/u);
    await expect(replies.finish()).rejects.toThrow(
      /Missing recorded TypeSafe request/,
    );
  });

  it("changes the request key when prompt wording changes", async () => {
    const first = await cassette();
    const a = new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: first.replies.fetch,
    });
    await a.choose("Click Save", options("random-a")).catch(() => undefined);
    await a.choose("Select Save", options("random-b")).catch(() => undefined);
    expect(new Set(first.replies.missing).size).toBe(2);
  });

  it("detects changed Judge claims and classification sentences", async () => {
    const { replies } = await cassette();
    const adapter = new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: replies.fetch,
    });
    await adapter
      .holds("Ready", { complete: true, text: "Ready" })
      .catch(() => undefined);
    await adapter
      .holds("Saved", { complete: true, text: "Ready" })
      .catch(() => undefined);
    await adapter.classifyBatch(["press Enter"]).catch(() => undefined);
    await adapter.classifyBatch(["press Tab"]).catch(() => undefined);
    expect(new Set(replies.missing).size).toBe(4);
  });

  it("replays a live-shaped reply against fresh random candidate IDs", async () => {
    const { path } = await cassette();
    let liveCalls = 0;
    vi.stubGlobal("fetch", async () => {
      liveCalls++;
      return new Response(
        JSON.stringify({
          answers: {
            target: {
              type: "choice",
              choice: "random-a",
              confidence: 0.9,
              probabilities: { "random-a": 0.9, none: 0.1 },
            },
          },
          model: "jev-1.13.0",
          usage: { input_tokens: 10, output_tokens: 0 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const record = await FixtureReplies.load(path, true);
    await new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: record.fetch,
    }).choose("Click Save", options("random-a"));
    await record.finish();
    const replay = await FixtureReplies.load(path);
    const selected = await new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: replay.fetch,
    }).choose("Click Save", options("different-run-id"));
    expect(selected.selection).toEqual({
      kind: "candidate",
      id: "different-run-id",
    });
    expect(liveCalls).toBe(1);
    await replay.finish();
    await expect((await FixtureReplies.load(path)).finish()).rejects.toThrow(
      /Unused recorded TypeSafe request/,
    );
    const file = JSON.parse(await readFile(path, "utf8")) as {
      entries: Array<{ response: Record<string, unknown> }>;
    };
    file.entries[0]!.response.authorization = "must never be committed";
    await writeFile(path, JSON.stringify(file));
    await expect(FixtureReplies.load(path)).rejects.toThrow(
      /Unexpected fixture provider fields/,
    );
  });

  it("rejects external question text before a live request", async () => {
    const { path } = await cassette();
    const live = vi.fn();
    vi.stubGlobal("fetch", live);
    const record = await FixtureReplies.load(path, true);
    const adapter = new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: record.fetch,
    });
    const offered = options("random-a");
    const candidate = offered.options[0];
    if (candidate?.kind !== "candidate") throw new Error("Missing candidate");
    await expect(
      adapter.choose("Click Save", {
        ...offered,
        options: [
          {
            ...candidate,
            candidate: {
              ...candidate.candidate,
              name: "https://external.example/secret",
            },
          },
          offered.options[1]!,
        ],
      }),
    ).rejects.toBeDefined();
    expect(live).not.toHaveBeenCalled();
  });

  it("rejects unexpected nested live reply data before recording", async () => {
    const { path } = await cassette();
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            answers: {
              target: {
                type: "choice",
                choice: "random-a",
                confidence: 0.9,
                probabilities: { "random-a": 0.9, none: 0.1 },
                authorization: "Bearer secret",
              },
            },
            model: "jev-1.13.0",
            usage: { input_tokens: 10, output_tokens: 2 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const record = await FixtureReplies.load(path, true);
    const adapter = new TypeSafeAdapter({
      apiKey: "fixture-key",
      fetch: record.fetch,
    });
    await expect(
      adapter.choose("Click Save", options("random-a")),
    ).rejects.toBeDefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual({
      version: 1,
      entries: [],
    });
  });

  it("rejects a stale key before any adapter call", async () => {
    const request = buildResolverRequest(
      "Click Save",
      options("random-a"),
    ).request;
    const key = createHash("sha256")
      .update(JSON.stringify(request))
      .digest("hex");
    const folder = await mkdtemp(join(tmpdir(), "sedum-replies-"));
    folders.push(folder);
    const path = join(folder, "replies.json");
    await writeFile(
      path,
      JSON.stringify({ version: 1, entries: [{ key, request, response: {} }] }),
    );
    await expect(FixtureReplies.load(path)).rejects.toThrow(/stale/);
  });
});
