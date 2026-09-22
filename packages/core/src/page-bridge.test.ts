import { describe, expect, it, vi } from "vitest";
import type { BrowserPage } from "./browser-driver.js";
import {
  collectCandidates,
  liveCandidates,
  matchLiveEntry,
  pageDigest,
  pageVersion,
  quietPage,
} from "./page-bridge.js";
import { stageEntry, type CacheEntry } from "./page-cache.js";
import type { Candidate, CandidatePage, PageVersion } from "./page-protocol.js";

const version: PageVersion = {
  document: "d",
  route: "https://example.test/?token=URLSECRET",
  revision: 1,
};
const candidate: Candidate = {
  ref: "run-ref",
  tag: "button",
  role: "button",
  name: "Buy",
  peers: ["Camera"],
  editable: false,
  disabled: false,
  inputType: "",
  signals: { path: "body:0/button:0", contextComplete: true },
};
const found: CandidatePage = {
  protocol: 1,
  version,
  total: 1,
  offset: 0,
  next: null,
  complete: true,
  candidates: [candidate],
};
const key = new Uint8Array(32).fill(3);
function fake(evaluate: (expression: string) => unknown): BrowserPage {
  return {
    evaluate: vi.fn(async (expression: string) => evaluate(expression)),
  } as unknown as BrowserPage;
}

describe("page bridge boundary", () => {
  it("reports missing, incompatible, and malformed script results", async () => {
    await expect(
      collectCandidates(
        fake(() => ({ installed: false })),
        "click",
      ),
    ).rejects.toMatchObject({ code: "missing" });
    await expect(
      collectCandidates(
        fake(() => ({ installed: true, protocol: 2 })),
        "click",
      ),
    ).rejects.toMatchObject({ code: "incompatible" });
    await expect(
      collectCandidates(
        fake(() => ({ installed: true, protocol: 1, value: {} })),
        "click",
      ),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      pageDigest(
        fake(() => ({ installed: true, protocol: 1, value: { text: "bad" } })),
      ),
    ).rejects.toMatchObject({ code: "invalid-result" });
    await expect(
      pageVersion(fake(() => ({ installed: true, protocol: 1, value: null }))),
    ).rejects.toMatchObject({ code: "invalid-result" });
    expect(() =>
      quietPage(
        fake(() => null),
        -1,
        100,
      ),
    ).toThrow(RangeError);
  });
  it("keeps the HMAC key in core and refuses a changed or incomplete live set", async () => {
    const entry: CacheEntry = stageEntry(
      key,
      version.route,
      "click",
      "Buy Camera",
      candidate,
      found,
    );
    const expressions: string[] = [];
    const page = fake((expression) => {
      expressions.push(expression);
      if (expression.includes('bridge["findBySignals"]'))
        return { installed: true, protocol: 1, value: found };
      return { installed: true, protocol: 1, value: version };
    });
    expect(
      await matchLiveEntry(page, entry, key, "click", "Buy Camera"),
    ).toMatchObject({ hit: true, candidate });
    expect(expressions.join(" ")).not.toContain(Array.from(key).join(","));
    const changed = fake((expression) => ({
      installed: true,
      protocol: 1,
      value: expression.includes('bridge["findBySignals"]')
        ? found
        : { ...version, revision: 2 },
    }));
    expect(
      await matchLiveEntry(changed, entry, key, "click", "Buy Camera"),
    ).toEqual({ hit: false, reason: "candidate_set_incomplete" });
    expect(await liveCandidates(page, "click")).toEqual(found);
  });
});
