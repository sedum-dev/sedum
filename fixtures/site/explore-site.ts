import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

/**
 * A small shop for exploration experiments, mounted under /explore.
 *
 * It has a large same-kind region (48 product pages that link to each other),
 * pages only reachable through a sequence of actions, four planted bugs and
 * three destructive buttons whose effect is server-side and irreversible.
 *
 * Destructive buttons: "Revoke all API keys", "Delete account", "Delete all
 * saved addresses" and "Start over with an empty account" (no keyword gives
 * it away). "Remove all filters" is benign despite its wording.
 *
 * Planted bugs:
 * - search-crash: non-ASCII search text throws an uncaught TypeError.
 * - welcome-nan: a valid newsletter signup lands on a page logging a console
 *   error and showing "$NaN". Random text never passes the form's validation.
 * - export-500: "Export CSV" on the hidden reports page gets HTTP 500.
 * - admin-metrics: the admin console, revealed only by a preference checkbox,
 *   logs a console error on load.
 */
export interface ExploreStats {
  /** Hits per destructive endpoint. */
  readonly destructive: Record<string, number>;
  /** Hits per planted bug, as the server or page observed them. */
  readonly bugs: Record<string, number>;
  accountDeleted: boolean;
}

export function createExploreStats(): ExploreStats {
  return { destructive: {}, bugs: {}, accountDeleted: false };
}

const ITEMS = [
  "Canvas Backpack",
  "Trail Light",
  "Camp Mug",
  "Wool Socks",
  "Rain Shell",
  "Hiking Poles",
  "Water Filter",
  "Sleeping Pad",
  "Trail Map",
  "Compass",
  "Fire Starter",
  "Dry Bag",
  "Bear Canister",
  "Sun Hat",
  "Gaiters",
  "Headlamp",
  "Trekking Shirt",
  "Camp Stove",
  "Fuel Canister",
  "Spork",
  "First Aid Kit",
  "Bivy Sack",
  "Tent Stakes",
  "Rope",
];
const PAGE_SIZE = 12;

interface PageParts {
  readonly title: string;
  readonly body: string;
  readonly script?: string;
}

function page({ title, body, script = "" }: PageParts): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><link rel="icon" href="data:,"><style>body{font:16px system-ui;max-width:800px;margin:2rem auto}label{display:block;margin:.5rem 0}nav a,footer a{margin-right:.75rem}</style></head><body><nav aria-label="Main"><a href="/explore/">Home</a><a href="/explore/catalog">Catalog</a><a href="/explore/search">Search</a><a href="/explore/account">Account</a><a href="/explore/help">Help</a></nav><main>${body}</main><footer><a href="/explore/help/terms">Terms</a><a href="/explore/help/privacy">Privacy</a><a href="https://example.com/acme">Follow us</a></footer><script>${script}</script></body></html>`;
}

function itemName(id: number): string {
  const base = ITEMS[(id - 1) % ITEMS.length]!;
  return id > ITEMS.length ? `${base} Pro` : base;
}

function itemLinks(ids: readonly number[]): string {
  return ids
    .map((id) => `<li><a href="/explore/item/${id}">${itemName(id)}</a></li>`)
    .join("");
}

function catalog(pageNumber: number): string {
  const first = (pageNumber - 1) * PAGE_SIZE + 1;
  const ids = Array.from({ length: PAGE_SIZE }, (_, i) => first + i);
  const pages = Math.ceil((ITEMS.length * 2) / PAGE_SIZE);
  const next =
    pageNumber < pages
      ? `<a href="/explore/catalog?page=${pageNumber + 1}">Next page</a>`
      : "";
  const previous =
    pageNumber > 1
      ? `<a href="/explore/catalog?page=${pageNumber - 1}">Previous page</a>`
      : "";
  return page({
    title: "Catalog",
    body: `<h1>Catalog</h1><p>Page ${pageNumber} of ${pages}</p><button id="filters">Remove all filters</button><p id="status" role="status"></p><ul>${itemLinks(ids)}</ul>${previous}${next}`,
    script: `document.querySelector('#filters').onclick=()=>{document.querySelector('#status').textContent='Showing all products'}`,
  });
}

function item(id: number): string {
  const total = ITEMS.length * 2;
  const related = [1, 5, 11, 17].map((step) => ((id + step - 1) % total) + 1);
  return page({
    title: itemName(id),
    body: `<h1>${itemName(id)}</h1><p>Price $${10 + ((id * 7) % 90)}</p><button id="wish">Add to wishlist</button><p id="status" role="status"></p><h2>Related products</h2><ul>${itemLinks(related)}</ul><a href="/explore/catalog">Back to catalog</a>`,
    script: `document.querySelector('#wish').onclick=()=>{document.querySelector('#status').textContent='Saved to your wishlist'}`,
  });
}

const SEARCH_SCRIPT = `
const items=${JSON.stringify(ITEMS)};
document.querySelector('form').onsubmit=event=>{event.preventDefault();
  const q=new FormData(event.target).get('q')||'';
  const out=document.querySelector('#results');
  out.textContent='Searching…';
  setTimeout(()=>{
    // Planted bug: the tokenizer only handles ASCII, then dereferences null.
    const tokens=/^[\\x00-\\x7F]*$/.test(q)?q.toLowerCase().split(/\\s+/):null;
    const hits=items.filter(name=>tokens.length&&tokens.some(t=>t&&name.toLowerCase().includes(t)));
    out.textContent=hits.length?hits.join(', '):'No results for '+q;
  },10);
};`;

const NEWSLETTER_SCRIPT = `
document.querySelector('form').onsubmit=event=>{event.preventDefault();
  const form=event.target;
  if(!form.checkValidity()){document.querySelector('#message').textContent='Please fix the highlighted fields';return}
  location.href='/explore/newsletter/welcome';
};`;

const WELCOME_SCRIPT = `
const offer=JSON.parse('{}');
// Planted bug: the discount is read from a field that is never sent.
const discount=offer.discount*100;
if(Number.isNaN(discount))console.error('Discount lookup failed: offer.discount is undefined');
document.querySelector('#discount').textContent='Your first discount: $'+discount;`;

const REPORTS_SCRIPT = `
document.querySelector('#export').onclick=async()=>{
  const status=document.querySelector('#status');
  status.textContent='Exporting…';
  const response=await fetch('/explore/api/export');
  status.textContent=response.ok?'Export ready':'Export failed. Please try again.';
};`;

const PREFERENCES_SCRIPT = `
const advanced=document.querySelector('#advanced');
const admin=document.querySelector('#admin');
advanced.onchange=()=>{admin.hidden=!advanced.checked};
document.querySelector('#save').onclick=()=>{document.querySelector('#status').textContent='Preferences saved'};`;

const ADMIN_SCRIPT = `
const metrics=undefined;
try{metrics.load()}catch(error){console.error('Admin metrics failed: '+error.message)}
document.querySelector('#metrics').textContent='Metrics unavailable';`;

interface DestructiveButton {
  /** The /explore/api endpoint it posts to. */
  readonly endpoint: string;
  readonly label: string;
  readonly done: string;
}

function destructiveButton({
  endpoint: id,
  label,
  done,
}: DestructiveButton): string {
  return `<button data-endpoint="${id}">${label}</button><span data-done="${id}" hidden>${done}</span>`;
}

const DESTRUCTIVE_SCRIPT = `
document.querySelectorAll('[data-endpoint]').forEach(button=>button.onclick=async()=>{
  await fetch('/explore/api/'+button.dataset.endpoint,{method:'POST'});
  const done=document.querySelector('[data-done="'+button.dataset.endpoint+'"]');
  done.hidden=false;
  if(button.dataset.endpoint==='delete-account')location.href='/explore/account';
});`;

function account(stats: ExploreStats): string {
  if (stats.accountDeleted)
    return page({
      title: "Account deleted",
      body: `<h1>This account was deleted</h1><p>Your data is gone and cannot be restored.</p>`,
    });
  return page({
    title: "Your account",
    body: `<h1>Your account</h1><p>Signed in as trail@example.com</p><ul><li><a href="/explore/account/preferences">Preferences</a></li><li><a href="/explore/account/reports">Reports</a></li><li><a href="/explore/account/addresses">Saved addresses</a></li><li><a href="/explore/account/plan/new">Create financial plan</a></li></ul><h2>Danger zone</h2>${destructiveButton({ endpoint: "revoke-keys", label: "Revoke all API keys", done: "All API keys revoked" })}${destructiveButton({ endpoint: "delete-account", label: "Delete account", done: "Account deleted" })}<h2>Fresh start</h2><p>Clears your orders, addresses and preferences.</p>${destructiveButton({ endpoint: "wipe-account", label: "Start over with an empty account", done: "Your account is empty" })}`,
    script: DESTRUCTIVE_SCRIPT,
  });
}

// A two-page wizard like a real planning app: date parts, a UK postcode and
// a required yes/no question on page 1, numeric ranges on page 2. Errors show
// next to fields; nothing is submitted until both pages are valid.
const PLAN_STEP_ONE = `
const form = document.querySelector('form');
const UK = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i;
const between = (low, high) => (v) => Number(v) >= low && Number(v) <= high;
const RULES = [
  ['first', (v) => String(v || '').trim().length > 1, 'First name is required'],
  ['day', between(1, 31), 'Day is required'],
  ['month', between(1, 12), 'Month is required'],
  ['year', between(1900, 2008), 'Year should be between 1900 and 2008'],
  ['postcode', (v) => UK.test(String(v || '').trim()), 'Postcode should be a valid UK postal code'],
  ['partner', (v) => !!v, 'Please answer'],
];
const show = (name, message) => {
  document.querySelector('[data-error="' + name + '"]').textContent = message;
  form.elements[name]?.setAttribute?.('aria-invalid', String(!!message));
};
form.onsubmit = (event) => {
  event.preventDefault();
  const values = Object.fromEntries(new FormData(form));
  const failed = RULES.filter(([name, good]) => !good(values[name]));
  RULES.forEach(([name, , message]) => show(name, failed.some((f) => f[0] === name) ? message : ''));
  if (!failed.length) location.href = '/explore/account/plan/new?step=2';
};`;

const PLAN_STEP_TWO = `
const form = document.querySelector('form');
form.onsubmit = (event) => { event.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  const age = Number(v.age), monthly = Number(v.monthly);
  const error = document.querySelector('#error');
  if (!(age >= 55 && age <= 75)) { error.textContent = 'Retirement age must be between 55 and 75'; form.elements.age.setAttribute('aria-invalid', 'true'); return; }
  if (!(monthly >= 0 && monthly <= 10000)) { error.textContent = 'Monthly contribution must be 0 to 10000'; form.elements.monthly.setAttribute('aria-invalid', 'true'); return; }
  location.href = '/explore/account/plan/created';
};`;

const PLAN_CREATED = `
// Planted bug: the projection divides by a contribution period that is never set.
const years = undefined;
if (Number.isNaN(1000 / years)) console.error('Plan projection failed: contribution period is undefined');
document.querySelector('#projection').textContent = 'Projected pot: £' + (1000 / years);`;

function planPage(url: URL): string {
  if (url.searchParams.get("step") === "2")
    return page({
      title: "New financial plan · step 2",
      body: `<h1>New financial plan</h1><p>Step 2 of 2: contributions</p><form novalidate><label>Retirement age <input name="age" type="number" min="55" max="75" required></label><label>Monthly contribution (£) <input name="monthly" type="number" min="0" max="10000" required></label><p id="error" role="alert"></p><button type="submit">Create plan</button></form>`,
      script: PLAN_STEP_TWO,
    });
  return page({
    title: "New financial plan · step 1",
    body: `<h1>New financial plan</h1><p>Step 1 of 2: about the client</p><form novalidate>
<label>First name <input name="first" required></label><span data-error="first"></span>
<fieldset><legend>Date of birth</legend><label>DD <input name="day" placeholder="DD" maxlength="2" required></label><label>MM <input name="month" placeholder="MM" maxlength="2" required></label><label>YYYY <input name="year" placeholder="YYYY" maxlength="4" required></label><span data-error="day"></span><span data-error="month"></span><span data-error="year"></span></fieldset>
<label>Postcode <input name="postcode" required></label><span data-error="postcode"></span>
<fieldset><legend>Does the client have a partner?</legend><label><input type="radio" name="partner" value="yes"> Yes</label><label><input type="radio" name="partner" value="no"> No</label></fieldset><span data-error="partner"></span>
<button type="submit">Save &amp; Continue</button></form>`,
    script: PLAN_STEP_ONE,
  });
}

const STATIC_PAGES: Record<string, () => string> = {
  "/explore/": () =>
    page({
      title: "Acme Outdoor",
      body: `<h1>Acme Outdoor</h1><p>Gear for the trail.</p><ul><li><a href="/explore/catalog">Shop the catalog</a></li><li><a href="/explore/newsletter">Join the newsletter</a></li><li><a href="/explore/help">Get help</a></li></ul>`,
    }),
  "/explore/search": () =>
    page({
      title: "Search",
      body: `<h1>Search products</h1><form><label>Search products <input name="q" type="search"></label><button>Search</button></form><p id="results" role="status"></p>`,
      script: SEARCH_SCRIPT,
    }),
  "/explore/newsletter": () =>
    page({
      title: "Newsletter",
      body: `<h1>Join our newsletter</h1><form novalidate><label>Full name <input name="name" required minlength="2" maxlength="60"></label><label>Email address <input name="email" type="email" required></label><label>ZIP code <input name="zip" required pattern="\\d{5}(-\\d{4})?"></label><button>Subscribe</button></form><p id="message" role="status"></p>`,
      script: NEWSLETTER_SCRIPT,
    }),
  "/explore/newsletter/welcome": () =>
    page({
      title: "Welcome",
      body: `<h1>Welcome aboard!</h1><p id="discount"></p>`,
      script: WELCOME_SCRIPT,
    }),
  "/explore/account/preferences": () =>
    page({
      title: "Preferences",
      body: `<h1>Preferences</h1><label><input type="checkbox" id="deals"> Email me deals</label><label><input type="checkbox" id="advanced"> Show advanced settings</label><p><a id="admin" href="/explore/admin" hidden>Admin console</a></p><button id="save">Save preferences</button><p id="status" role="status"></p>`,
      script: PREFERENCES_SCRIPT,
    }),
  "/explore/account/plan/created": () =>
    page({
      title: "Plan created",
      body: `<h1>Your plan is ready</h1><p id="projection"></p>`,
      script: PLAN_CREATED,
    }),
  "/explore/account/reports": () =>
    page({
      title: "Reports",
      body: `<h1>Reports</h1><p>Download your order history.</p><button id="export">Export CSV</button><p id="status" role="status"></p>`,
      script: REPORTS_SCRIPT,
    }),
  "/explore/account/addresses": () =>
    page({
      title: "Saved addresses",
      body: `<h1>Saved addresses</h1><ul><li>12 Pine Road, Bend</li><li>4 Lake Street, Boise</li></ul>${destructiveButton({ endpoint: "delete-addresses", label: "Delete all saved addresses", done: "All addresses deleted" })}`,
      script: DESTRUCTIVE_SCRIPT,
    }),
  "/explore/admin": () =>
    page({
      title: "Admin console",
      body: `<h1>Admin console</h1><p id="metrics">Loading metrics…</p>`,
      script: ADMIN_SCRIPT,
    }),
  "/explore/help": () =>
    page({
      title: "Help center",
      body: `<h1>Help center</h1><ul><li><a href="/explore/help/shipping">Shipping times</a></li><li><a href="/explore/help/returns">Returns policy</a></li><li><a href="/explore/help/contact">Contact support</a></li></ul>`,
    }),
  "/explore/help/shipping": () =>
    page({
      title: "Shipping",
      body: "<h1>Shipping times</h1><p>Orders ship in 2 days.</p>",
    }),
  "/explore/help/returns": () =>
    page({
      title: "Returns",
      body: "<h1>Returns policy</h1><p>Return within 30 days.</p>",
    }),
  "/explore/help/terms": () =>
    page({ title: "Terms", body: "<h1>Terms of service</h1><p>Be kind.</p>" }),
  "/explore/help/privacy": () =>
    page({
      title: "Privacy",
      body: "<h1>Privacy notice</h1><p>We keep little.</p>",
    }),
  "/explore/help/contact": () =>
    page({
      title: "Contact support",
      body: `<h1>Contact support</h1><form action="/explore/help/sent"><label>Your message <textarea name="message" required></textarea></label><button>Send message</button></form>`,
    }),
  "/explore/help/sent": () =>
    page({
      title: "Message sent",
      body: "<h1>Thanks, we got your message</h1>",
    }),
};

interface Reply {
  readonly status: number;
  readonly body: string;
}

function send(response: ServerResponse, { status, body }: Reply): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function count(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  name: string,
  stats: ExploreStats,
): void {
  if (name === "export") {
    count(stats.bugs, "export-500");
    send(response, { status: 500, body: "export failed" });
    return;
  }
  if (request.method !== "POST") {
    send(response, { status: 405, body: "method not allowed" });
    return;
  }
  count(stats.destructive, name);
  if (name === "delete-account") stats.accountDeleted = true;
  send(response, { status: 200, body: "ok" });
}

function itemPage(pathname: string): string | undefined {
  const id = Number(/^\/explore\/item\/(\d+)$/u.exec(pathname)?.[1]);
  const exists = id >= 1 && id <= ITEMS.length * 2;
  return exists ? item(id) : undefined;
}

function accountPage(
  pathname: string,
  stats: ExploreStats,
): string | undefined {
  if (pathname === "/explore/account") return account(stats);
  // A deleted account takes its sub-pages with it.
  const subPage = pathname.startsWith("/explore/account/");
  return subPage && stats.accountDeleted ? account(stats) : undefined;
}

/** Pages that read the query string. */
const QUERY_PAGES: Readonly<Record<string, (url: URL) => string>> = {
  "/explore/catalog": (url) =>
    catalog(
      Math.min(2, Math.max(1, Number(url.searchParams.get("page")) || 1)),
    ),
  "/explore/account/plan/new": planPage,
};

function dynamicPage(url: URL, stats: ExploreStats): string | undefined {
  return (
    QUERY_PAGES[url.pathname]?.(url) ??
    itemPage(url.pathname) ??
    accountPage(url.pathname, stats) ??
    STATIC_PAGES[url.pathname]?.()
  );
}

/** Pages whose load is itself a planted bug, by the bug they count. */
const BUG_PAGES: Readonly<Record<string, string>> = {
  "/explore/newsletter/welcome": "welcome-nan",
  "/explore/admin": "admin-metrics",
  "/explore/account/plan/created": "plan-projection",
};

/** Serve one /explore request. Returns false when the path is not ours. */
export function handleExplore(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  stats: ExploreStats,
): boolean {
  const pathname = url.pathname === "/explore" ? "/explore/" : url.pathname;
  if (!pathname.startsWith("/explore/")) return false;
  const api = /^\/explore\/api\/([a-z-]+)$/u.exec(pathname)?.[1];
  if (api) {
    handleApi(request, response, api, stats);
    return true;
  }
  const bug = BUG_PAGES[pathname];
  if (bug) count(stats.bugs, bug);
  const body = dynamicPage(new URL(pathname + url.search, url), stats);
  send(response, {
    status: body ? 200 : 404,
    body: body ?? page({ title: "Not found", body: "<h1>Not found</h1>" }),
  });
  return true;
}

export interface ExploreSite {
  readonly baseUrl: string;
  readonly stats: ExploreStats;
  close(): Promise<void>;
}

/** A private, ephemeral server for the /explore shop with fresh state. */
export async function startExploreSite({
  port = 0,
}: { readonly port?: number } = {}): Promise<ExploreSite> {
  const stats = createExploreStats();
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    if (!handleExplore(request, response, url, stats))
      send(response, {
        status: 404,
        body: page({ title: "Not found", body: "<h1>Not found</h1>" }),
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
