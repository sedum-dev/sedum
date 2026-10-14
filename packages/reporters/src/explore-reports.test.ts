import { describe, expect, it } from "vitest";
import type { ExploreRunResult } from "@sedum-dev/core";
import { renderExploreHtml } from "./explore-html.js";
import { renderExploreMarkdown } from "./explore-markdown.js";

const hostile =
  "# Heading\n<img src=x onerror=alert(1)></script><script>alert(2)</script> [link](http://evil.test)";

const run: ExploreRunResult = {
  sedumExplore: 1,
  runId: "r1",
  startUrl: "https://shop.test/",
  seed: 7,
  mode: "guided",
  safety: "off",
  detect: "browser",
  startedAt: "2026-10-14T00:00:00.000Z",
  durationMs: 1500,
  steps: { requested: 10, taken: 2 },
  stopReason: null,
  verdict: "findings",
  findings: [
    {
      id: "F1",
      signature: "console: boom",
      kind: "console",
      message: hostile,
      step: 1,
      route: "/search",
      test: {
        path: "tests/finding-F1.test.yaml",
        yaml: 'url: https://shop.test/\nsteps:\n  - click the "Search" link\n',
        actionsBefore: 9,
        actionsAfter: 1,
        reproduced: true,
        sentences: { matched: 1, located: 1 },
      },
    },
  ],
  coverage: {
    states: 2,
    routes: [{ route: "/search", visits: 2 }],
    pageKinds: { search: 2 },
  },
  writes: [{ endpoint: "POST /api/search", count: 1, firstStep: 1 }],
  skipped: ["Log out"],
  jev: {
    calls: 2,
    inputTokens: 200,
    costUsd: 0.002,
    latencyMs: { p50: 90, p95: 110 },
    errors: [],
  },
  timeline: [
    {
      step: 0,
      route: "/",
      action: 'click link "Search"',
      outcome: "acted",
      planned: false,
      signatures: [],
      writes: [],
      frames: {
        before: "frames/step-0-before.jpg",
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.05 },
      },
    },
    {
      step: 1,
      route: "/search",
      action: `type "</script>" into "Search"`,
      outcome: "acted",
      planned: false,
      signatures: ["console: boom"],
      writes: ["POST /api/search"],
      frames: { after: "frames/step-1.jpg" },
    },
  ],
  artifacts: {
    directory: ".sedum/explore/r1",
    trace: "trace.jsonl",
    frames: true,
    tests: ["tests/finding-F1.test.yaml"],
  },
};

describe("exploration reports", () => {
  it("markdown opens with the verdict and fences page text", () => {
    const md = renderExploreMarkdown(run);
    expect(md.split("\n")[2]).toContain("**1 finding** in 2 of 10 steps");
    expect(md.match(/# Heading/g)?.length).toBe(1);
    expect(md).toContain("```text\n# Heading");
    expect(md).toContain(
      "sedum run .sedum/explore/r1/tests/finding-F1.test.yaml --detect browser",
    );
    expect(md).toContain("| `POST /api/search` | 1 | 1 |");
  });

  it("html escapes page text, embeds frames, and loads nothing", () => {
    const frames = new Map([
      ["frames/step-0-before.jpg", new Uint8Array([1, 2, 3])],
      ["frames/step-1.jpg", new Uint8Array([4, 5, 6])],
    ]);
    const html = renderExploreHtml(run, { frames });
    expect(html).not.toContain("<script>alert(2)");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("data:image/jpeg;base64,BAUG");
    expect(html.match(/<\/script>/g)?.length).toBe(2);
    expect(html).not.toMatch(/(src|href)="https?:/u);
  });

  it("html says how to get frames when the run has none", () => {
    const timeline = run.timeline.map((step) => {
      const { frames, ...rest } = step;
      void frames;
      return rest;
    });
    const html = renderExploreHtml({ ...run, timeline });
    expect(html).toContain("Run with <code>--replay</code>");
  });
});
