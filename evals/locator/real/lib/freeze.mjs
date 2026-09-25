/**
 * In-page freezer. Runs inside the live page and turns the current DOM into
 * one static HTML document: scripts removed, stylesheets inlined from the
 * CSSOM (including constructed and CSS-in-JS rules), open shadow roots kept
 * as declarative shadow DOM, form state written to attributes, and images
 * replaced by transparent placeholders of the same rendered size. Cross-origin
 * stylesheets that the CSSOM cannot read are returned for Node to fetch.
 */
export const FREEZE = `(() => {
  const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
  const roots = [];
  const collect = (root) => {
    for (const el of root.querySelectorAll("*"))
      if (el.shadowRoot) { roots.push(el.shadowRoot); collect(el.shadowRoot); }
  };
  collect(document);
  const scopes = [document, ...roots];

  const sheetText = (sheet, depth = 0) => {
    const parts = [];
    for (const rule of sheet.cssRules) {
      if (rule instanceof CSSImportRule && rule.styleSheet && depth < 4) {
        try { parts.push(sheetText(rule.styleSheet, depth + 1)); } catch { parts.push(rule.cssText); }
      } else parts.push(rule.cssText);
    }
    return parts.join("\\n");
  };

  // Form state lives in properties; keep what a person sees as attributes.
  for (const scope of scopes)
    for (const el of scope.querySelectorAll("input,option,details")) {
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio"))
        el.toggleAttribute("checked", el.checked);
      if (el instanceof HTMLOptionElement) el.toggleAttribute("selected", el.selected);
    }

  // Images keep their rendered box but never load.
  for (const scope of scopes) {
    for (const el of scope.querySelectorAll("img,input[type=image],video,iframe,embed,object")) {
      let rect = null;
      try { rect = Element.prototype.getBoundingClientRect.call(el); } catch {}
      if (rect && rect.width > 0 && rect.height > 0) {
        el.style.setProperty("width", rect.width + "px");
        el.style.setProperty("height", rect.height + "px");
      }
      if (el.matches("img,input[type=image]")) {
        el.setAttribute("src", PIXEL);
        el.removeAttribute("srcset");
        el.removeAttribute("sizes");
        el.removeAttribute("loading");
      } else if (el.matches("video")) {
        el.removeAttribute("src");
        el.removeAttribute("poster");
        el.querySelectorAll("source,track").forEach((s) => s.remove());
      } else if (el.matches("iframe")) {
        el.setAttribute("src", "about:blank");
        el.removeAttribute("srcdoc");
      } else el.replaceWith(document.createElement("span"));
    }
    scope.querySelectorAll("picture source,audio").forEach((el) => el.remove());
    scope.querySelectorAll("image[href],image[*|href]").forEach((el) => {
      el.removeAttribute("href");
      el.removeAttributeNS("http://www.w3.org/1999/xlink", "href");
    });
  }

  // Stylesheets become inline <style> elements in cascade order.
  const pending = [];
  const sheetKeys = new Map();
  const sheets = {};
  let next = 0;
  for (const scope of scopes) {
    for (const link of scope.querySelectorAll('link[rel~="stylesheet"]')) {
      const style = document.createElement("style");
      if (link.media) style.setAttribute("media", link.media);
      if (link.disabled) { link.remove(); continue; }
      try {
        style.textContent = link.sheet ? sheetText(link.sheet) : "";
      } catch {
        const id = "freeze-" + next++;
        style.setAttribute("data-freeze-fetch", id);
        pending.push({ id, href: link.href });
      }
      link.replaceWith(style);
    }
    for (const style of scope.querySelectorAll("style:not([data-freeze-fetch])")) {
      try { if (style.sheet) style.textContent = sheetText(style.sheet); } catch {}
    }
    const adopted = scope.adoptedStyleSheets ?? [];
    if (adopted.length) {
      // Shared constructed sheets are stored once and re-adopted on load.
      const keys = adopted.map((sheet) => {
        if (!sheetKeys.has(sheet)) {
          const key = "s" + sheetKeys.size;
          sheetKeys.set(sheet, key);
          try { sheets[key] = sheetText(sheet); } catch { sheets[key] = ""; }
        }
        return sheetKeys.get(sheet);
      });
      (scope === document ? document.documentElement : scope.host)
        .setAttribute("data-freeze-adopt", keys.join(" "));
    }
  }

  // Nothing executable or network-bound survives.
  for (const scope of scopes)
    scope.querySelectorAll(
      "script,noscript,link,base,meta[http-equiv],template:not([shadowrootmode])",
    ).forEach((el) => el.remove());
  for (const scope of scopes)
    for (const el of scope.querySelectorAll("[srcset],[integrity],[nonce],[ping]")) {
      el.removeAttribute("srcset");
      el.removeAttribute("integrity");
      el.removeAttribute("nonce");
      el.removeAttribute("ping");
    }

  const html = document.documentElement;
  const attrs = [...html.attributes].map((a) => a.name + '="' + a.value.replace(/"/g, "&quot;") + '"').join(" ");
  const inner = html.getHTML({ serializableShadowRoots: true, shadowRoots: roots });
  return {
    html: "<!doctype html><html " + attrs + ">" + inner + "</html>",
    pending,
    sheets,
    shadowRoots: roots.length,
  };
})()`;

/**
 * Re-adopt shared constructed stylesheets after parsing. The snapshot's only
 * script: it reads inline data and touches no network.
 */
export function adoptionScript(sheets) {
  if (!Object.keys(sheets).length) return "";
  const data = JSON.stringify(sheets).replace(/</g, "\\u003c");
  return (
    '<script id="sedum-freeze-sheets" type="application/json">' +
    data +
    "</script><script>(() => {" +
    "const text = JSON.parse(document.getElementById('sedum-freeze-sheets').textContent);" +
    "const made = {};" +
    "const sheet = (k) => made[k] || (made[k] = (() => { const s = new CSSStyleSheet(); try { s.replaceSync(text[k] || ''); } catch {} return s; })());" +
    "const visit = (root) => { for (const el of root.querySelectorAll('[data-freeze-adopt]')) {" +
    "const target = el === document.documentElement ? document : el.shadowRoot;" +
    "if (target) target.adoptedStyleSheets = el.getAttribute('data-freeze-adopt').split(' ').map(sheet); }" +
    "for (const el of root.querySelectorAll('*')) if (el.shadowRoot) visit(el.shadowRoot); };" +
    "visit(document);" +
    "})();</script>"
  );
}

/** Neutralize every external url() and oversized inline asset in CSS. */
export function stripUrls(html) {
  return html
    .replace(/url\(\s*(['"]?)(?!data:)[^)'"]*\1\s*\)/gi, "none")
    .replace(/url\(\s*(['"]?)data:[^)'"]{40000,}\1\s*\)/gi, "none")
    .replace(/:not\(:defined\)/g, ":not(*)");
}
