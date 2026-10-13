import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { expect, it, test as propertyTest } from "vitest";
import type { BrowserPage } from "../browser-driver.js";
import type { BugDetector } from "../detector/detector.js";
import { detectStep } from "./detection.js";

const found = [
  {
    check: "http_error" as const,
    message: "GET https://shop.test/api/orders?token=abc returned 500",
    url: "https://shop.test/api/orders?token=abc",
    status: 500,
  },
  {
    check: "console_error" as const,
    message: "Payment failed for card 4242",
  },
];
const detector = {
  inspectStep: async () => ({ detections: found, calls: [], inspections: [] }),
} as unknown as BugDetector;
const page = {} as BrowserPage;

it("reports URLs without their query and redacts secrets", async () => {
  const { detections } = await detectStep(page, detector, {
    privacy: { secretValues: ["4242"], sensitiveOrigins: [] },
    sensitive: false,
  });
  expect(detections).toEqual([
    {
      check: "http_error",
      message: "GET https://shop.test/api/orders returned 500",
      url: "https://shop.test/api/orders",
      status: 500,
    },
    { check: "console_error", message: "Payment failed for card [REDACTED]" },
  ]);
});

const privacy = {
  secretValues: [],
  sensitiveOrigins: ["https://auth.test"],
} as const;
const reported = async (message: string, url?: string) =>
  (
    await detectStep(
      page,
      {
        inspectStep: async () => ({
          detections: [
            { check: "http_error", message, ...(url ? { url } : {}) },
          ],
          calls: [],
          inspections: [],
        }),
      } as unknown as BugDetector,
      { privacy: { ...privacy, secretValues: [] }, sensitive: false },
    )
  ).detections[0]!;

it("strips the query from a URL the collector clipped", async () => {
  const url = `https://bucket.test/report.pdf?X-Amz-Credential=AKIAEXAMPLE&X-Amz-Signature=${"f".repeat(400)}`;
  const clipped = `GET ${url.slice(0, 299)}… returned 403 Forbidden`;
  const detection = await reported(clipped, url);
  expect(detection.message).toBe(
    "GET https://bucket.test/report.pdf returned 403 Forbidden",
  );
  expect(detection.url).toBe("https://bucket.test/report.pdf");
  // A clip inside the path is still marked.
  expect(
    (await reported("GET https://bucket.test/rep… returned 404")).message,
  ).toBe("GET https://bucket.test/rep… returned 404");
});

it("strips queries from every URL Chrome quotes in a message", async () => {
  const detection = await reported(
    "Access to fetch at 'https://api.test/me?access_token=t0k3n' from origin 'https://app.test' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
  );
  expect(detection.message).toBe(
    "Access to fetch at 'https://api.test/me' from origin 'https://app.test' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
  );
});

it("keeps sentence punctuation and reduces sensitive origins in messages", async () => {
  expect(
    (await reported("Failed to load https://cdn.test/app.js?v=2. Retrying."))
      .message,
  ).toBe("Failed to load https://cdn.test/app.js. Retrying.");
  expect(
    (await reported("GET https://auth.test/session/42?code=abc returned 500"))
      .message,
  ).toBe("GET https://auth.test returned 500");
});

it.each([
  [
    "https://en.wikipedia.org/wiki/Mercury_(planet)?token=t0k3n",
    "https://en.wikipedia.org/wiki/Mercury_(planet)",
  ],
  [
    "https://shop.test/api/items?filter[status]=open&token=t0k3n",
    "https://shop.test/api/items",
  ],
  ["https://shop.test/search?q={x}&token=t0k3n", "https://shop.test/search"],
  [
    "https://shop.test/o'brien/profile?token=t0k3n",
    "https://shop.test/o'brien/profile",
  ],
])("keeps URL characters a browser leaves raw: %s", async (raw, kept) => {
  expect((await reported(`GET ${raw} returned 500`)).message).toBe(
    `GET ${kept} returned 500`,
  );
  expect(
    (
      await reported(
        `Access to fetch at '${raw}' from origin 'https://app.test'`,
      )
    ).message,
  ).toBe(`Access to fetch at '${kept}' from origin 'https://app.test'`);
});

it("drops a URL nested in another URL's query with that query", async () => {
  expect(
    (
      await reported(
        "GET https://shop.test/login?next=https://shop.test/me?token=t0k3n returned 302",
      )
    ).message,
  ).toBe("GET https://shop.test/login returned 302");
});

it("keeps only the check on a sensitive page", async () => {
  const { detections } = await detectStep(page, detector, {
    privacy: { secretValues: [], sensitiveOrigins: ["https://shop.test"] },
    sensitive: true,
  });
  expect(detections.map((d) => [d.check, d.message, d.url])).toEqual([
    ["http_error", "Details omitted on a sensitive page.", "https://shop.test"],
    ["console_error", "Details omitted on a sensitive page.", undefined],
  ]);
});

it("does nothing without a detector", async () => {
  expect(
    await detectStep(page, undefined, {
      privacy: { secretValues: [], sensitiveOrigins: [] },
      sensitive: false,
    }),
  ).toEqual({ detections: [], calls: [] });
});

// Properties of the URL reduction in messages. URLs are built with `new URL`,
// so they are serialized the way a browser reports them: `( ) [ ] { } '` can
// appear raw in paths and queries.
const propertySettings = {
  database: { kind: "disabled" },
  derandomize: true,
  testCases: 500,
  verbosity: hegel.Verbosity.Quiet,
} satisfies Partial<hegel.Settings>;

/** Never generated by the alphabets below, and hosts are lowercased. */
const MARKER = "SECRETQZ";
const PATH_CHARS = "abcxyz09-._~!$&'()*+,;=:@é[]{}";
const QUERY_CHARS = "abcxyz09-._~!$&'()*+,;=:@/?[]{}|^é ";
const TEMPLATES: readonly ((url: string) => string)[] = [
  (url) => `GET ${url} returned 500 Internal Server Error`,
  (url) =>
    `Access to fetch at '${url}' from origin 'https://app.test' has been blocked by CORS policy.`,
  (url) => `Failed to load ${url}.`,
  (url) => `see (${url}), then retry`,
  (url) => `"${url}"`,
  (url) => `<${url}>`,
  (url) => url,
];

function drawUrl(
  tc: hegel.TestCase,
  { tidyEnd }: { readonly tidyEnd: boolean },
): URL {
  const scheme = tc.draw(gs.sampledFrom(["http", "https", "ws", "wss"]));
  const host = tc.draw(
    gs.oneOf(
      gs.domains({ maxLength: 30 }),
      gs.sampledFrom(["127.0.0.1:8080", "[::1]:3000", "bücher.test"]),
    ),
  );
  const url = new URL(`${scheme}://${host}/`);
  const segments = tc.draw(
    gs.arrays(gs.text({ alphabet: PATH_CHARS, maxSize: 8 }), { maxSize: 3 }),
  );
  url.pathname = `/${segments.join("/")}`;
  const noise = tc.draw(gs.text({ alphabet: QUERY_CHARS, maxSize: 12 }));
  // A query value can end in punctuation; where the URL then ends is
  // ambiguous, so the exact property keeps its last character plain.
  const end = tidyEnd ? "x" : "";
  const where = tc.draw(gs.sampledFrom(["query", "fragment", "both"]));
  if (where !== "fragment") url.search = `${noise}&token=${MARKER}${end}`;
  if (where !== "query") url.hash = `${noise}${MARKER}${end}`;
  return url;
}

async function reportMessage(
  message: string,
  sensitiveOrigins: readonly string[] = [],
): Promise<string> {
  const reported = await detectStep(
    page,
    {
      inspectStep: async () => ({
        detections: [{ check: "console_error", message }],
        calls: [],
        inspections: [],
      }),
    } as unknown as BugDetector,
    { privacy: { secretValues: [], sensitiveOrigins }, sensitive: false },
  );
  return reported.detections[0]!.message;
}

propertyTest(
  "a URL in a message keeps exactly its origin and path",
  async () => {
    await hegel.testAsync(async (tc) => {
      const url = drawUrl(tc, { tidyEnd: true });
      const template = tc.draw(gs.sampledFrom(TEMPLATES));
      const reported = await reportMessage(template(url.href));
      const expected = template(`${url.origin}${url.pathname}`);
      if (reported !== expected)
        throw new Error(`${template(url.href)} became ${reported}`);
    }, propertySettings);
  },
);

propertyTest("a URL on a sensitive origin keeps only the origin", async () => {
  await hegel.testAsync(async (tc) => {
    const url = drawUrl(tc, { tidyEnd: true });
    const template = tc.draw(gs.sampledFrom(TEMPLATES));
    const reported = await reportMessage(template(url.href), [url.origin]);
    if (reported !== template(url.origin))
      throw new Error(`${template(url.href)} became ${reported}`);
  }, propertySettings);
});

propertyTest(
  "no query or fragment reaches the report, even from a clipped URL",
  async () => {
    await hegel.testAsync(async (tc) => {
      const url = drawUrl(tc, { tidyEnd: false });
      const clip = tc.draw(gs.booleans());
      const at = tc.draw(
        gs.integers({ minValue: url.origin.length, maxValue: url.href.length }),
      );
      const text = clip ? `${url.href.slice(0, at)}…` : url.href;
      const message = tc.draw(gs.sampledFrom(TEMPLATES))(text);
      const reported = await reportMessage(message);
      if (reported.includes(MARKER))
        throw new Error(`${message} leaked as ${reported}`);
      if ((await reportMessage(reported)) !== reported)
        throw new Error(`Reducing ${reported} again changed it`);
    }, propertySettings);
  },
);
