import { describe, expect, it } from "vitest";
import {
  DEFAULT_ALLOW,
  allowed,
  parseAllowRule,
  signalDetection,
  textDetections,
  uniqueDetections,
  type Detection,
} from "./checks.js";

const http = (url: string, status = 404): Detection =>
  signalDetection({
    kind: "http_error",
    message: `GET ${url} returned ${status}`,
    url,
    status,
  });

describe("allow rules", () => {
  it("matches a substring of the message or URL, scoped to a check", () => {
    const rule = parseAllowRule("http_error:/api/session");
    expect(allowed(http("https://a.test/api/session"), [rule])).toBe(true);
    expect(allowed(http("https://a.test/api/orders"), [rule])).toBe(false);
    const consoleError: Detection = {
      check: "console_error",
      source: "browser",
      message: "/api/session failed",
    };
    expect(allowed(consoleError, [rule])).toBe(false);
  });

  it("treats an unknown prefix as part of an unscoped pattern", () => {
    const rule = parseAllowRule("https://cdn.test/font.woff");
    expect(rule.check).toBeNull();
    expect(allowed(http("https://cdn.test/font.woff"), [rule])).toBe(true);
  });

  it("reads re: as a regular expression and keeps paths literal", () => {
    const regex = parseAllowRule("console_error:re:^ResizeObserver loop");
    const ok: Detection = {
      check: "console_error",
      source: "browser",
      message: "ResizeObserver loop completed with undelivered notifications.",
    };
    expect(allowed(ok, [regex])).toBe(true);
    // A path with slashes is a substring, not /regex/flags.
    const path = parseAllowRule("http_error:/detector/api/session");
    expect(allowed(http("http://x/detector/api/session", 401), [path])).toBe(
      true,
    );
  });

  it("rejects an empty pattern or an invalid regular expression", () => {
    expect(() => parseAllowRule("http_error: ")).toThrow();
    expect(() => parseAllowRule("re:(")).toThrow();
  });

  it("allows favicon misses and ResizeObserver noise by default", () => {
    const rules = DEFAULT_ALLOW.map(parseAllowRule);
    expect(allowed(http("https://a.test/favicon.ico"), rules)).toBe(true);
    expect(allowed(http("https://a.test/logo.png"), rules)).toBe(false);
  });
});

describe("exact text leaks", () => {
  it.each([
    ["Hello, undefined!", "undefined"],
    ["Total: $NaN", "NaN"],
    ["Ship to: [object Object]", "[object Object]"],
    ["Placed on Invalid Date", "Invalid Date"],
    ["Welcome back, {{user.firstName}}", "template"],
    ["Price ${item.price}", "template"],
  ])("finds %j", (text, label) => {
    const found = textDetections(text);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ check: "broken_value", source: "text" });
    expect(found[0]!.message).toContain(label);
  });

  it.each([
    "Grandma Nan's Bakery",
    "Undefined-hours holidays",
    "an undefinedValue in code",
    "Use {{ }} braces",
    "Products Canvas Backpack $29.00",
  ])("ignores %j", (text) => {
    expect(textDetections(text)).toEqual([]);
  });

  it("quotes a bounded excerpt around the match", () => {
    const text = `${"a".repeat(200)} undefined ${"b".repeat(200)}`;
    const [found] = textDetections(text);
    expect(found!.message.length).toBeLessThan(140);
    expect(found!.message).toMatch(/…a+ undefined b+…/u);
  });
});

it("keeps one detection per check and message", () => {
  const one = http("https://a.test/x");
  expect(
    uniqueDetections([one, { ...one }, http("https://a.test/y")]),
  ).toHaveLength(2);
});
