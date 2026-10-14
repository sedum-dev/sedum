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
  /** Successful saves per non-destructive write endpoint. */
  readonly writes: Record<string, number>;
  accountDeleted: boolean;
}

export function createExploreStats(): ExploreStats {
  return { destructive: {}, bugs: {}, writes: {}, accountDeleted: false };
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
    body: `<h1>Your account</h1><p>Signed in as trail@example.com</p><ul><li><a href="/explore/account/preferences">Preferences</a></li><li><a href="/explore/account/reports">Reports</a></li><li><a href="/explore/account/addresses">Saved addresses</a></li><li><a href="/explore/account/trip/new">Plan a trip</a></li><li><a href="/explore/account/accounts">Linked accounts</a></li><li><a href="/explore/account/branding">Store branding</a></li></ul><h2>Danger zone</h2>${destructiveButton({ endpoint: "revoke-keys", label: "Revoke all API keys", done: "All API keys revoked" })}${destructiveButton({ endpoint: "delete-account", label: "Delete account", done: "Account deleted" })}<h2>Fresh start</h2><p>Clears your orders, addresses and preferences.</p>${destructiveButton({ endpoint: "wipe-account", label: "Start over with an empty account", done: "Your account is empty" })}`,
    script: DESTRUCTIVE_SCRIPT,
  });
}

// A wizard like a real planning app: date parts, a UK postcode and
// a required yes/no question on page 1, numeric ranges on page 2. Errors show
// next to fields; nothing is submitted until both pages are valid.
const TRIP_STEP_ONE = `
const form = document.querySelector('form');
const UK = /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i;
const between = (low, high) => (v) => Number(v) >= low && Number(v) <= high;
const RULES = [
  ['first', (v) => String(v || '').trim().length > 1, 'First name is required'],
  ['day', between(1, 31), 'Day is required'],
  ['month', between(1, 12), 'Month is required'],
  ['year', between(1900, 2008), 'Year should be between 1900 and 2008'],
  ['postcode', (v) => UK.test(String(v || '').trim()), 'Postcode should be a valid UK postal code'],
  ['companion', (v) => !!v, 'Please answer'],
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
  if (!failed.length) location.href = '/explore/account/trip/new?step=gear';
};`;

const TRIP_STEP_THREE = `
const form = document.querySelector('form');
form.onsubmit = (event) => { event.preventDefault();
  const v = Object.fromEntries(new FormData(form));
  const group = Number(v.group), budget = Number(v.budget);
  const error = document.querySelector('#error');
  if (!(group >= 1 && group <= 12)) { error.textContent = 'Group size must be between 1 and 12'; form.elements.group.setAttribute('aria-invalid', 'true'); return; }
  if (!(budget >= 0 && budget <= 10000)) { error.textContent = 'Daily budget must be 0 to 10000'; form.elements.budget.setAttribute('aria-invalid', 'true'); return; }
  location.href = '/explore/account/trip/created';
};`;

const TRIP_CREATED = `
// Planted bug: the estimate divides by a trip length that is never set.
const days = undefined;
if (Number.isNaN(1000 / days)) console.error('Trip estimate failed: trip length is undefined');
document.querySelector('#estimate').textContent = 'Estimated cost: £' + (1000 / days);`;

// Like a real app's "Add account" dialog: no dialog role, labels
// as plain text, a custom div dropdown with a heading, a native select with
// a placeholder, a field no format rule knows, and errors only in a summary.
const ACCOUNTS_SCRIPT = `
const $ = (id) => document.getElementById(id);
$('add').onclick = () => { $('modal').hidden = false; };
$('cancel').onclick = () => { $('modal').hidden = true; };
$('type').onclick = () => { $('type-menu').hidden = !$('type-menu').hidden; };
// Like a menu still loading: the first click on an option does nothing.
let loaded = false;
document.querySelectorAll('.opt').forEach((option) => option.onclick = () => {
  if (!loaded) { loaded = true; return; }
  $('type').textContent = option.textContent; $('type').dataset.value = option.textContent;
  $('type-menu').hidden = true;
});
// A type-ahead widget over a hidden select, like Tom Select.
$('store-search').oninput = () => {
  const query = $('store-search').value.toLowerCase();
  $('store-results').innerHTML = '';
  [...$('store').options].filter((o) => o.value && o.text.toLowerCase().includes(query)).forEach((o) => {
    const row = document.createElement('div');
    row.textContent = o.text; row.style.cursor = 'pointer';
    row.onclick = () => { $('store').value = o.value; $('store-search').value = o.text; $('store-results').innerHTML = ''; };
    $('store-results').append(row);
  });
};
const CHECKS = [
  [() => $('name').value.trim(), 'Account name is required'],
  [() => /^[0-9]{8}$/.test($('accountId').value), 'Account ID must be 8 digits'],
  [() => $('provider').value, 'Provider is required'],
  [() => $('type').dataset.value, 'Account type is required'],
  [() => $('store').value, 'Home store is required'],
  [() => /^[0-9]{6}$/.test($('member').value), 'Member code must be 6 digits'],
  [() => Number($('balance').value) > 0, 'Balance must be a number above 0'],
];
$('save').onclick = async () => {
  const failed = CHECKS.filter(([ok]) => !ok()).map(([, message]) => message);
  $('summary').hidden = !failed.length;
  $('summary').innerHTML = 'Error: Incomplete information<ul>' + failed.map((m) => '<li>' + m + '</li>').join('') + '</ul>';
  if (failed.length) return;
  await fetch('/explore/api/accounts', { method: 'POST' });
  location.href = '/explore/account/accounts/saved';
};`;

const ACCOUNT_TYPES = ["Checking", "Savings", "Credit card", "Store card"];

function accountsPage(): string {
  const options = ACCOUNT_TYPES.map(
    (name) => `<div class="opt" style="cursor:pointer">${name}</div>`,
  ).join("");
  return page({
    title: "Linked accounts",
    body: `<h1>Linked accounts</h1><p>No accounts yet.</p><button id="add">Add account</button>
<div id="modal" hidden><h2>Add new account</h2>
<label for="name">Account name</label><input id="name">
<label for="accountId">Account ID</label><input id="accountId">
<label for="provider">Provider</label><select id="provider"><option value="">Select a provider</option><option>Northbank</option><option>Riverside</option><option>Other</option></select>
<div>Account type</div><div><div id="type" style="cursor:pointer">Select an account type</div><div id="type-menu" hidden><div>Most common</div>${options}</div></div>
<label for="store">Home store</label><select id="store" style="position:absolute;width:1px;height:1px;opacity:0"><option value="">Choose a store</option><option value="l">London</option><option value="m">Manchester</option><option value="b">Bristol</option></select><div><input id="store-search" placeholder="Choose a store" autocomplete="off"><div id="store-results"></div></div>
<label for="member">Member code</label><input id="member">
<label for="balance">Balance</label><input id="balance" placeholder="0.00">
<div id="summary" hidden></div>
<button id="cancel">Cancel</button><button id="save">Save account</button></div>`,
    script: ACCOUNTS_SCRIPT,
  });
}

// A store-wide setting with a single empty field: the macro must not save it.
const BRANDING_SCRIPT = `
document.getElementById('apply').onclick = async () => {
  if (!document.getElementById('colour').value) return;
  await fetch('/explore/api/branding', { method: 'POST' });
  document.getElementById('status').textContent = 'Branding applied to every store page';
};`;

// Sign up needs a new password typed twice; sign in needs a real one.
const REGISTER_SCRIPT = `
document.querySelector('form').onsubmit = async (event) => {
  event.preventDefault();
  const v = Object.fromEntries(new FormData(event.target));
  const CHECKS = [
    [!!v.name, 'Name is required'],
    [/@/.test(v.email || ''), 'Email is required'],
    [(v.password || '').length >= 8, 'Password needs 8 characters'],
    [v.password === v.confirm, 'Passwords must match'],
  ];
  const failed = CHECKS.find(([ok]) => !ok);
  document.getElementById('error').textContent = failed ? failed[1] : '';
  if (failed) return;
  await fetch('/explore/api/register', { method: 'POST' });
  location.href = '/explore/register/done';
};`;

const ACCOUNT_SAVED = `
// Planted bug: the total reads a balance field the list never sends.
const total = [{ name: 'New account' }].reduce((sum, a) => sum + a.balance, 0);
if (Number.isNaN(total)) console.error('Account total failed: balance is missing');`;

// Like a real app's list step: Continue stays disabled until
// an item is added through a sub-form the page reveals.
const TRIP_GEAR = `
const $ = (id) => document.getElementById(id);
$('add-item').onclick = () => { $('sub').hidden = false; };
$('item-save').onclick = () => {
  const missing = [['item-name', 'Item name is required'], ['item-category', 'Category is required'], ['item-quantity', 'Quantity must be above 0']]
    .filter(([id]) => !(id === 'item-quantity' ? Number($(id).value) > 0 : $(id).value)).map(([, message]) => message);
  $('item-error').textContent = missing.join('. ');
  if (missing.length) return;
  $('items').insertAdjacentHTML('beforeend', '<li>' + $('item-name').value + '</li>');
  $('sub').hidden = true;
  $('continue').disabled = false;
};
$('continue').onclick = () => { location.href = '/explore/account/trip/new?step=2'; };`;

const TRIP_GEAR_BODY = `<h1>New trip</h1><p>Step 2 of 3: gear</p><ul id="items"></ul>
<button id="add-item" type="button">Add an item</button>
<div id="sub" hidden><label>Item name <input id="item-name"></label><label>Category <select id="item-category"><option value="">Select a category</option><option>Tent</option><option>Backpack</option></select></label><label>Quantity <input id="item-quantity" type="number" min="1" max="20"></label><button id="item-save" type="button">Save item</button><p id="item-error"></p></div>
<button id="continue" type="button" disabled>Save &amp; Continue</button>`;

function tripPage(url: URL): string {
  if (url.searchParams.get("step") === "gear")
    return page({
      title: "New trip · gear",
      body: TRIP_GEAR_BODY,
      script: TRIP_GEAR,
    });
  if (url.searchParams.get("step") === "2")
    return page({
      title: "New trip · budget",
      body: `<h1>New trip</h1><p>Step 3 of 3: budget</p><form novalidate><label>Group size <input name="group" type="number" min="1" max="12" required></label><label>Daily budget (£) <input name="budget" type="number" min="0" max="10000" required></label><p id="error" role="alert"></p><button type="submit">Create trip</button></form>`,
      script: TRIP_STEP_THREE,
    });
  return page({
    title: "New trip · about you",
    body: `<h1>New trip</h1><p>Step 1 of 3: about you</p><form novalidate>
<label>First name <input name="first" required></label><span data-error="first"></span>
<fieldset><legend>Date of birth</legend><label>DD <input name="day" placeholder="DD" maxlength="2" required></label><label>MM <input name="month" placeholder="MM" maxlength="2" required></label><label>YYYY <input name="year" placeholder="YYYY" maxlength="4" required></label><span data-error="day"></span><span data-error="month"></span><span data-error="year"></span></fieldset>
<label>Postcode <input name="postcode" required></label><span data-error="postcode"></span>
<fieldset><legend>Is anyone travelling with you?</legend><label><input type="radio" name="companion" value="yes"> Yes</label><label><input type="radio" name="companion" value="no"> No</label></fieldset><span data-error="companion"></span>
<button type="submit">Save &amp; Continue</button></form>`,
    script: TRIP_STEP_ONE,
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
  "/explore/account/accounts": accountsPage,
  "/explore/account/accounts/saved": () =>
    page({
      title: "Account saved",
      body: `<h1>Account saved</h1><p id="total"></p>`,
      script: ACCOUNT_SAVED,
    }),
  "/explore/register": () =>
    page({
      title: "Create an account",
      body: `<h1>Create an account</h1><form novalidate><label>Name <input name="name"></label><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><label>Confirm password <input name="confirm" type="password"></label><p id="error" role="alert"></p><button>Create account</button></form>`,
      script: REGISTER_SCRIPT,
    }),
  // Two forms on one page, and a Cancel button before the real submit.
  "/explore/support": () =>
    page({
      title: "Support",
      body: `<h1>Support</h1><form role="search" action="/explore/search"><label>Search help <input name="q"></label><button>Search</button></form>
<form id="contact"><label>Your name <input name="name"></label><label>Email <input name="email" type="email"></label><label>Card number <input name="card"></label><label>Message <textarea name="message"></textarea></label><button type="button" onclick="location.href='/explore/'">Cancel</button><input type="submit" value="Send message"></form>`,
      script: `document.getElementById('contact').onsubmit = async (event) => {
  event.preventDefault();
  const v = Object.fromEntries(new FormData(event.target));
  if (!/^4242/.test(v.card)) return;
  await fetch('/explore/api/support', { method: 'POST' });
  location.href = '/explore/help/sent';
};`,
    }),
  "/explore/lottery": () =>
    page({
      title: "Lottery",
      body: `<h1>Lottery</h1><button id="draw">Draw</button><p id="out"></p>`,
      script: `document.getElementById('draw').onclick = async () => {
  const r = await fetch('/explore/api/draw');
  document.getElementById('out').textContent = r.ok ? 'You drew a ticket' : 'Try again';
};`,
    }),
  "/explore/register/done": () =>
    page({ title: "Welcome", body: "<h1>Your account is ready</h1>" }),
  "/explore/signin": () =>
    page({
      title: "Sign in",
      body: `<h1>Sign in</h1><form action="/explore/signin"><label>Email <input name="email" type="email"></label><label>Password <input name="password" type="password"></label><button>Sign in</button></form>`,
    }),
  "/explore/account/branding": () =>
    page({
      title: "Store branding",
      body: `<h1>Store branding</h1><p>Applies to every page of your store.</p><label>Brand colour <input id="colour" placeholder="#000000"></label><button id="apply">Save &amp; Apply</button><p id="status" role="status"></p>`,
      script: BRANDING_SCRIPT,
    }),
  "/explore/account/trip/created": () =>
    page({
      title: "Trip created",
      body: `<h1>Your trip is ready</h1><p id="estimate"></p>`,
      script: TRIP_CREATED,
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
  const reply = READ_APIS[name]?.(stats);
  if (reply) {
    send(response, reply);
    return;
  }
  if (request.method !== "POST") {
    send(response, { status: 405, body: "method not allowed" });
    return;
  }
  count(WRITE_ENDPOINTS.has(name) ? stats.writes : stats.destructive, name);
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
  "/explore/account/trip/new": tripPage,
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
  "/explore/account/trip/created": "trip-estimate",
  "/explore/account/accounts/saved": "account-total",
};

/** GET endpoints with planted failures. */
const READ_APIS: Readonly<Record<string, (stats: ExploreStats) => Reply>> = {
  export: (stats) => {
    count(stats.bugs, "export-500");
    return { status: 500, body: "export failed" };
  },
  // An intermittent bug: every second draw fails.
  draw: (stats) => {
    count(stats.bugs, "draw");
    const fails = stats.bugs["draw"]! % 2 === 0;
    return fails
      ? { status: 500, body: "draw failed" }
      : { status: 200, body: "ok" };
  },
};

/** Ordinary saves: counted, never destructive. */
const WRITE_ENDPOINTS = new Set([
  "accounts",
  "branding",
  "register",
  "support",
]);

/** Pages served as they are, without the shop's layout. */
const RAW_PAGES: Readonly<Record<string, Reply>> = {
  // A host's error page: nothing to click or fill.
  "/explore/blank": { status: 503, body: "<!doctype html><p>Back soon.</p>" },
  // Like a single-page app on static hosting: a 404 page that sends the
  // browser straight on to the app. Not a dead end for the user.
  "/explore/moved": {
    status: 404,
    body: `<!doctype html><script>location.replace("/explore/help")</script>`,
  },
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
  // Like a single-page app on static hosting: a 404 page that sends the
  // browser straight on to the app. Not a dead end for the user.
  const raw = RAW_PAGES[pathname];
  if (raw) {
    send(response, raw);
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
