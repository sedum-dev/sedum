/**
 * Page-script source that finds elements by the scanner's element path
 * (tag and index among same-tag siblings, 12 levels up). Click candidates
 * are found this way: their refs are gone once the fields were scanned.
 * Defines `byPaths(paths)`, a Map from each path found to its element.
 */
export const BY_PATHS = String.raw`
  const step = (n) => n.tagName.toLowerCase() + ":" + (n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName).indexOf(n) : 0);
  const pathOf = (e) => { const steps = []; for (let n = e; n && steps.length < 12; n = n.parentElement) steps.unshift(step(n)); return steps.join("/"); };
  const byPaths = (paths) => {
    const tags = [...new Set(paths.map((p) => p.split("/").pop().split(":")[0]))].filter((t) => /^[a-z][a-z0-9-]*$/.test(t));
    const found = new Map();
    if (tags.length) for (const e of document.querySelectorAll(tags.join(","))) found.set(pathOf(e), e);
    return found;
  };`;
