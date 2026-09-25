/**
 * In-page helpers shared by the inspector and the harness. `DEEP_QUERY`
 * resolves a target selector chain, where " >>> " steps into an open shadow
 * root. `INVENTORY` lists everything a person could plausibly click or type
 * into, with a unique selector chain for each.
 */
export const DEEP_QUERY = `(chain) => {
  let scope = document;
  const parts = chain.split(" >>> ");
  let found = null;
  for (let i = 0; i < parts.length; i++) {
    const matches = scope.querySelectorAll(parts[i]);
    if (matches.length !== 1) return { error: matches.length ? "matches " + matches.length + " elements" : "matches nothing", step: i };
    found = matches[0];
    if (i < parts.length - 1) {
      if (!found.shadowRoot) return { error: "has no open shadow root", step: i };
      scope = found.shadowRoot;
    }
  }
  return { element: found };
}`;

export const INVENTORY = `(() => {
  const WIDGET_ROLES = new Set(["button","link","checkbox","radio","switch","tab","menuitem","menuitemcheckbox","menuitemradio","option","textbox","searchbox","combobox","spinbutton","slider","treeitem","gridcell"]);
  const autoId = (id) => /\\d{4,}|^:|^[a-f0-9-]{10,}$|^[A-Za-z]+_[A-Za-z0-9]{5,}$|__/.test(id);
  const esc = (s) => CSS.escape(s);
  function localSelector(el, root) {
    const unique = (sel) => { try { return root.querySelectorAll(sel).length === 1; } catch { return false; } };
    if (el.id && !autoId(el.id) && unique("#" + esc(el.id))) return "#" + esc(el.id);
    for (const attr of ["data-testid", "data-test", "data-qa", "name", "aria-label"]) {
      const v = el.getAttribute(attr);
      if (v && v.length < 80) {
        const sel = el.localName + "[" + attr + '="' + v.replace(/"/g, '\\\\"') + '"]';
        if (unique(sel)) return sel;
      }
    }
    const steps = [];
    for (let node = el; node && node !== root && node.nodeType === 1; node = node.parentElement) {
      if (node !== el && node.id && !autoId(node.id) && unique("#" + esc(node.id))) { steps.unshift("#" + esc(node.id)); break; }
      const parent = node.parentElement;
      const siblings = parent ? parent.children : node.parentNode ? node.parentNode.children : [node];
      const same = [...siblings].filter((c) => c.localName === node.localName);
      steps.unshift(node.localName + (same.length > 1 ? ":nth-of-type(" + (same.indexOf(node) + 1) + ")" : ""));
      if (!parent) break;
    }
    return steps.join(" > ");
  }
  function chain(el) {
    const parts = [];
    let node = el;
    for (;;) {
      const root = node.getRootNode();
      parts.unshift(localSelector(node, root));
      if (root instanceof ShadowRoot) node = root.host; else break;
    }
    return parts.join(" >>> ");
  }
  const clean = (value) => (value ?? "").replace(/\\s+/g, " ").trim();
  function text(el) {
    const byIds = (el.getAttribute("aria-labelledby") || "").split(/\\s+/).filter(Boolean)
      .map((id) => clean(el.getRootNode().getElementById?.(id)?.textContent)).join(" ");
    const labels = el.labels ? [...el.labels].map((l) => clean(l.textContent)).join(" ") : "";
    const alt = [...el.querySelectorAll("img[alt],svg title")].map((n) => clean(n.getAttribute?.("alt") ?? n.textContent)).join(" ");
    return clean(byIds || labels || clean(el.innerText) || clean(el.textContent) || alt).slice(0, 80);
  }
  function candidate(el, parentPointer) {
    if (el.matches("a[href],button,input:not([type=hidden]),select,textarea,summary,[contenteditable]:not([contenteditable=false]),[onclick],[tabindex]:not([tabindex='-1'])")) return true;
    // A label that toggles a visually hidden checkbox or radio is the control people click.
    if (el.matches("label[for]")) {
      const control = el.getRootNode().getElementById?.(el.htmlFor);
      if (control && control.matches("input[type=checkbox],input[type=radio]")) {
        const box = control.getBoundingClientRect();
        if (box.width < 2 || box.height < 2 || getComputedStyle(control).opacity === "0") return true;
      }
    }
    const role = (el.getAttribute("role") || "").split(" ")[0];
    if (WIDGET_ROLES.has(role)) return true;
    return getComputedStyle(el).cursor === "pointer" && !parentPointer;
  }
  const items = [];
  function visit(root) {
    for (const el of root.querySelectorAll("*")) {
      if (el.shadowRoot) visit(el.shadowRoot);
      const parent = el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
      const parentPointer = parent ? getComputedStyle(parent).cursor === "pointer" : false;
      if (!candidate(el, parentPointer)) continue;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1 || style.visibility === "hidden" || style.display === "none") continue;
      items.push({
        n: items.length + 1,
        selector: chain(el),
        tag: el.localName,
        role: el.getAttribute("role") || "",
        type: el.getAttribute("type") || "",
        label: el.getAttribute("aria-label") || "",
        text: text(el),
        placeholder: el.getAttribute("placeholder") || "",
        title: el.getAttribute("title") || "",
        href: el.getAttribute("href") || "",
        shadow: el.getRootNode() instanceof ShadowRoot,
        sedum: el.hasAttribute("data-inspect-click") ? "click" : el.hasAttribute("data-inspect-fill") ? "fill" : "",
        box: { x: Math.round(rect.x + scrollX), y: Math.round(rect.y + scrollY), w: Math.round(rect.width), h: Math.round(rect.height) },
      });
    }
  }
  visit(document);
  return items;
})()`;
