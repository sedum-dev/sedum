import { describe, expect, it } from "vitest";
import {
  judgeText,
  parseSnapshot,
  projectSnapshot,
  resolverPage,
  snapshotText,
  type ObservedCandidate,
} from "./snapshot-observation.js";

describe("structured snapshot projection", () => {
  it("rejects malformed nodes and field types", () => {
    expect(() => parseSnapshot({ role: "button" })).toThrow("snapshot_invalid");
    expect(() => parseSnapshot([{ role: "button", name: 3 }])).toThrow(
      "snapshot_invalid",
    );
    expect(() => parseSnapshot([{ role: "button", children: {} }])).toThrow(
      "snapshot_invalid",
    );
  });

  it("uses the nearest named item context for repeated controls", () => {
    const tree = parseSnapshot([
      {
        role: "region",
        children: [
          {
            role: "article",
            children: [
              { role: "heading", name: "Amber mug" },
              { role: "paragraph", text: "$12" },
              { role: "button", name: "Add to cart" },
            ],
          },
          {
            role: "article",
            children: [
              { role: "heading", name: "Blue mug" },
              { role: "paragraph", text: "$12" },
              { role: "button", name: "Add to cart" },
            ],
          },
        ],
      },
    ]);
    const candidates = projectSnapshot(tree, "click");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      name: "Add to cart",
      peers: ["Amber mug", "$12"],
      itemRole: "article",
      itemHeading: "Amber mug",
    });
    expect(candidates[1]?.peers).toEqual(["Blue mug", "$12"]);
  });

  it("omits editable text from snapshot text and rejects oversized candidate fields", () => {
    const tree = parseSnapshot([
      {
        role: "main",
        children: [
          { role: "paragraph", text: "Visible claim" },
          { role: "textbox", name: "Coupon", text: "editable secret" },
        ],
      },
    ]);
    expect(snapshotText(tree)).toBe("Visible claim");
    expect(() =>
      projectSnapshot(
        parseSnapshot([{ role: "button", name: "😀".repeat(121) }]),
        "click",
      ),
    ).toThrow("candidate_field_too_large");
    expect(
      projectSnapshot(
        parseSnapshot([{ role: "button", name: "😀".repeat(120) }]),
        "click",
      ),
    ).toHaveLength(1);
    expect(() =>
      projectSnapshot(
        parseSnapshot([
          {
            role: "article",
            children: [
              { role: "heading", name: "P".repeat(81) },
              { role: "button", name: "Add" },
            ],
          },
        ]),
        "click",
      ),
    ).toThrow("candidate_field_too_large");
    expect(() =>
      projectSnapshot(parseSnapshot([{ role: "button" }]), "click"),
    ).toThrow("snapshot_invalid");
    expect(() =>
      projectSnapshot(
        parseSnapshot(
          Array.from({ length: 2049 }, (_, index) => ({
            role: "button",
            name: `Item ${index}`,
          })),
        ),
        "click",
      ),
    ).toThrow("candidate_set_incomplete");
  });

  it("pages Resolver candidates with only the allowed fields", () => {
    const candidates: ObservedCandidate[] = Array.from(
      { length: 129 },
      (_, index) => ({
        id: `opaque-${index}`,
        tag: "button",
        role: "button",
        name: `Add ${index}`,
        peers: ["Amber mug"],
        editable: false,
        disabled: false,
        signals: {
          path: "html:0/body:1/button:0",
          href: "/secret?token=x",
          hook: "private",
        },
      }),
    );
    const complete = {
      complete: true as const,
      version: { document: 1, route: "https://example.test/", signature: "x" },
      candidates,
      digest: "Visible",
    };
    const first = resolverPage(complete);
    expect(first.candidates).toHaveLength(128);
    expect(first.next).toBe(128);
    expect(resolverPage(complete, 128).candidates).toHaveLength(1);
    expect(first.candidates[0]).toEqual({
      id: "opaque-0",
      tag: "button",
      role: "button",
      name: "Add 0",
      peers: ["Amber mug"],
      editable: false,
      disabled: false,
    });
    expect(JSON.stringify(first)).not.toMatch(/secret|private|path|href/);
    expect(() =>
      resolverPage({
        complete: false,
        reason: "digest_incomplete",
        candidates: [],
      }),
    ).toThrow("observation_incomplete");
    expect(judgeText(complete)).toBe("Visible");
    expect(judgeText({ ...complete, digest: "😀".repeat(4096) })).toBe(
      "😀".repeat(4096),
    );
    expect(() => judgeText({ ...complete, digest: "A".repeat(4097) })).toThrow(
      "observation_incomplete",
    );
  });
});
