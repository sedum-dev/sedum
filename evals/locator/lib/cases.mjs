import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const OPERATIONS = new Set(["click", "fill", "read"]);
// Matches the attribute in plain markup and inside srcdoc or script strings.
const GOLD_ATTRIBUTE = /data-eval-gold=(?:"|'|&quot;|\\")([^"'&\\]+)/g;

/** Every `data-eval-gold` id in a page, with how often each appears. */
export function goldIds(html) {
  const counts = new Map();
  for (const match of html.matchAll(GOLD_ATTRIBUTE))
    counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  return counts;
}

/**
 * A suite names one `page`, or `variants` mapping a coding-style name to a
 * page. Variants render the same interface, so every case runs once per
 * variant with the same sentence and gold ids.
 */
function suitePages(suite) {
  if (suite.variants && typeof suite.variants === "object")
    return Object.entries(suite.variants).map(([variant, page]) => ({
      variant,
      page,
    }));
  return [{ variant: null, page: suite.page }];
}

/** Load every suite and report problems that would make a case meaningless. */
export function loadSuites(root) {
  const dir = join(root, "cases");
  const problems = [];
  const seen = new Set();
  const cases = [];
  for (const file of readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()) {
    const where = `cases/${file}`;
    let suite;
    try {
      suite = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch (error) {
      problems.push(`${where}: invalid JSON (${error.message})`);
      continue;
    }
    const pages = [];
    for (const { variant, page } of suitePages(suite)) {
      const pagePath = join(root, "pages", page ?? "");
      if (!page || !existsSync(pagePath)) {
        problems.push(`${where}: page ${page} does not exist`);
        continue;
      }
      const ids = goldIds(readFileSync(pagePath, "utf8"));
      for (const [id, count] of ids)
        if (count > 1)
          problems.push(`pages/${page}: gold id ${id} appears ${count} times`);
      pages.push({ variant, page, ids });
    }
    if (pages.length === 0) continue;
    for (const testCase of suite.cases ?? []) {
      const label = `${where} ${testCase.id ?? "(no id)"}`;
      if (!testCase.id || seen.has(testCase.id))
        problems.push(`${label}: missing or duplicate case id`);
      seen.add(testCase.id);
      if (!OPERATIONS.has(testCase.op))
        problems.push(`${label}: op must be click, fill, or read`);
      if (typeof testCase.sentence !== "string" || !testCase.sentence.trim())
        problems.push(`${label}: missing sentence`);
      if (!Array.isArray(testCase.tags) || testCase.tags.length === 0)
        problems.push(`${label}: needs at least one tag`);
      if (Array.isArray(testCase.gold)) {
        if (testCase.gold.length === 0)
          problems.push(`${label}: gold list is empty`);
        for (const { page, ids } of pages)
          for (const id of testCase.gold)
            if (!ids.has(id))
              problems.push(`${label}: gold ${id} is not marked in ${page}`);
      } else if (testCase.gold !== "none" && testCase.gold !== "ambiguous")
        problems.push(`${label}: gold must be ids, "none", or "ambiguous"`);
      for (const { variant, page } of pages)
        cases.push(
          variant === null
            ? { ...testCase, page }
            : { ...testCase, id: `${testCase.id}@${variant}`, page, variant },
        );
    }
  }
  return { cases, problems };
}
