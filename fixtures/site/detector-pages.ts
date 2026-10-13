/**
 * Bug-detector fixture pages: planted defects of each kind and clean
 * controls, with their labels. Labels name the checks a case must raise on
 * its load step and, after clicking `#act`, on its action step. `tolerate`
 * names checks that are defensible extras and count as neither hit nor miss.
 */
export type DetectorLabel =
  | "console_error"
  | "uncaught_exception"
  | "unhandled_rejection"
  | "http_error"
  | "error_message"
  | "stuck_loading"
  | "empty_content"
  | "broken_value";

export interface DetectorCase {
  readonly id: string;
  /** dev cases tune thresholds; heldout cases only report. */
  readonly split: "dev" | "heldout";
  readonly expect: {
    readonly load: readonly DetectorLabel[];
    readonly action?: readonly DetectorLabel[];
  };
  readonly tolerate?: readonly DetectorLabel[];
  readonly status?: number;
  readonly title: string;
  readonly body: string;
  readonly script?: string;
}

const NAV = `<header><strong>Acme Store</strong> <nav><a href="/detector/clean-products">Shop</a> <a href="/detector/clean-orders">Orders</a> <a href="/detector/clean-account">Account</a></nav></header>`;
const FOOTER = `<footer><small>© 2026 Acme Store · Help · Privacy</small></footer>`;

function shell(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title><style>body{font:16px system-ui;max-width:860px;margin:1rem auto}header,footer{display:flex;gap:1rem;padding:.5rem 0}article,section{border:1px solid #ccc;padding:.75rem;margin:.75rem 0}.skeleton{background:#eee;height:1rem;margin:.4rem 0;border-radius:4px}</style></head><body>${NAV}<main>${body}</main>${FOOTER}<script>${script}</script></body></html>`;
}

const PRODUCTS = `<h1>Products</h1><article><h2>Canvas Backpack</h2><p>Price $29.00</p><button>Add to cart</button></article><article><h2>Trail Light</h2><p>Price $9.00</p><button>Add to cart</button></article>`;
const ORDERS_TABLE = `<h1>Your orders</h1><table><thead><tr><th>Order</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody><tr><td>#1042</td><td>12 Oct 2026</td><td>$41.00</td><td>Shipped</td></tr><tr><td>#1039</td><td>2 Oct 2026</td><td>$9.00</td><td>Delivered</td></tr></tbody></table>`;
const ACT = (label: string) => `<button id="act">${label}</button>`;
const SET = (selector: string, text: string) =>
  `document.querySelector('${selector}').textContent=${JSON.stringify(text)}`;

const CASES: readonly DetectorCase[] = [
  // Deterministic browser signals.
  {
    id: "console-error",
    split: "dev",
    expect: { load: ["console_error"] },
    title: "Products",
    body: PRODUCTS,
    script: `console.error("Failed to load recommendations", {code: "RECS_TIMEOUT"})`,
  },
  {
    id: "uncaught-exception",
    split: "dev",
    expect: { load: ["uncaught_exception"] },
    title: "Products",
    body: PRODUCTS,
    script: `setTimeout(()=>{const cart=undefined;cart.items.push(1)},20)`,
  },
  {
    id: "unhandled-rejection",
    split: "dev",
    expect: { load: ["unhandled_rejection"] },
    title: "Products",
    body: PRODUCTS,
    script: `fetch('/detector/api/ok').then(r=>r.json()).then(()=>{throw new Error('Unexpected response shape')})`,
  },
  {
    id: "fetch-500",
    split: "dev",
    expect: { load: ["http_error"] },
    title: "Your orders",
    body: ORDERS_TABLE,
    script: `fetch('/detector/api/fail').catch(()=>{})`,
  },
  {
    // A pre-signed-style URL longer than a finding's message limit.
    id: "long-url-500",
    split: "heldout",
    expect: { load: ["http_error"] },
    title: "Your orders",
    body: ORDERS_TABLE,
    script: `fetch('/detector/api/fail?token=fixture-secret&pad=${"x".repeat(500)}').catch(()=>{})`,
  },
  {
    id: "xhr-404",
    split: "heldout",
    expect: { load: ["http_error"] },
    title: "Products",
    body: PRODUCTS,
    script: `const x=new XMLHttpRequest();x.open('GET','/detector/api/missing');x.send()`,
  },
  {
    id: "image-404",
    split: "heldout",
    expect: { load: ["http_error"] },
    title: "Products",
    body: PRODUCTS.replace(
      "<h2>Trail Light</h2>",
      `<h2>Trail Light</h2><img alt="" src="/detector/img/trail-light.png" width="40" height="40">`,
    ),
  },
  {
    id: "network-failure",
    split: "heldout",
    expect: { load: ["http_error"] },
    title: "Products",
    body: PRODUCTS,
    script: `fetch('/detector/api/drop').catch(()=>{})`,
  },
  {
    id: "document-500",
    split: "dev",
    status: 500,
    expect: { load: ["http_error", "error_message"] },
    title: "Server error",
    body: `<h1>Oops</h1><p>We hit a snag loading this page. Our team has been notified.</p>`,
  },
  {
    id: "click-save-500",
    split: "dev",
    expect: { load: [], action: ["http_error"] },
    title: "Profile",
    body: `<h1>Profile</h1><label>Display name <input value="Sam"></label>${ACT("Save")}<p id="msg"></p>`,
    script: `document.querySelector('#act').onclick=()=>{fetch('/detector/api/fail',{method:'POST'}).catch(()=>{});${SET("#msg", "Saved")}}`,
  },
  {
    id: "click-exception",
    split: "heldout",
    expect: { load: [], action: ["uncaught_exception"] },
    title: "Cart",
    body: `<h1>Cart</h1><ul><li>Canvas Backpack $29.00</li></ul>${ACT("Apply coupon")}`,
    script: `document.querySelector('#act').onclick=()=>{const coupon=null;coupon.code.trim()}`,
  },
  {
    id: "click-rejection",
    split: "heldout",
    expect: { load: [], action: ["unhandled_rejection"] },
    title: "Checkout",
    body: `<h1>Checkout</h1><p>Total $38.00</p>${ACT("Place order")}<p id="msg"></p>`,
    script: `document.querySelector('#act').onclick=async()=>{${SET("#msg", "Order placed")};await Promise.reject(new Error('payment token expired'))}`,
  },
  // Deterministic controls.
  {
    id: "clean-warnings",
    split: "dev",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
    script: `console.warn("Deprecated API used");console.log("analytics ready");console.info("v2.3.1")`,
  },
  {
    id: "clean-caught",
    split: "dev",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
    script: `try{null.x}catch(e){};fetch('/detector/api/ok').then(r=>r.json()).catch(()=>{})`,
  },
  {
    id: "clean-late-handler",
    split: "heldout",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
    script: `const p=Promise.reject(new Error('retry later'));setTimeout(()=>p.catch(()=>{}),30)`,
  },
  {
    id: "clean-expected-401",
    split: "dev",
    expect: { load: [] },
    title: "Sign in",
    body: `<h1>Sign in</h1><form><label>Email <input></label><label>Password <input type="password"></label><button type="button">Sign in</button></form>`,
    // Probing a session while signed out is normal; the evaluation allow-lists it.
    script: `fetch('/detector/api/session').catch(()=>{})`,
  },
  {
    id: "clean-redirect",
    split: "heldout",
    expect: { load: [] },
    title: "Your orders",
    body: ORDERS_TABLE,
    script: `fetch('/detector/api/moved').then(r=>r.json()).catch(()=>{})`,
  },
  // Visible error messages.
  {
    id: "error-banner",
    split: "dev",
    expect: { load: ["error_message"] },
    title: "Your orders",
    body: `<h1>Your orders</h1><section role="alert"><strong>Something went wrong.</strong> We couldn't load your orders. Please try again later. Reference: 8f2a91</section>`,
  },
  {
    id: "error-stack-trace",
    split: "dev",
    expect: { load: ["error_message"] },
    tolerate: ["broken_value"],
    title: "Orders",
    body: `<h1>Error</h1><pre>TypeError: Cannot read properties of undefined (reading 'map')
    at OrderList (orders.js:42:17)
    at renderWithHooks (react-dom.js:1:2)</pre>`,
  },
  {
    id: "error-next-client",
    split: "heldout",
    expect: { load: ["error_message"] },
    title: "Acme Store",
    body: `<h2>Application error: a client-side exception has occurred (see the browser console for more information).</h2>`,
  },
  {
    id: "error-widget",
    split: "heldout",
    expect: { load: ["error_message"] },
    title: "Canvas Backpack",
    body: `<h1>Canvas Backpack</h1><p>Price $29.00</p><button>Add to cart</button><section><h2>Reviews</h2><p>Unable to load reviews. <button>Retry</button></p></section>`,
  },
  {
    id: "error-503-text",
    split: "heldout",
    expect: { load: ["error_message"] },
    title: "Checkout",
    body: `<h1>503 Service Unavailable</h1><p>The server is temporarily unable to service your request. Please try again later.</p>`,
  },
  {
    id: "error-after-pay",
    split: "dev",
    expect: { load: [], action: ["error_message"] },
    title: "Payment",
    body: `<h1>Payment</h1><p>Total $38.00</p>${ACT("Pay now")}<p id="msg" role="status"></p>`,
    script: `document.querySelector('#act').onclick=()=>{${SET("#msg", "Oops! We couldn't process your payment due to an internal error (code PAY-500).")}}`,
  },
  // Stuck loading.
  {
    id: "loading-forever",
    split: "dev",
    expect: { load: ["stuck_loading"] },
    tolerate: ["empty_content"],
    title: "Your orders",
    body: `<h1>Your orders</h1><p aria-busy="true">Loading…</p>`,
  },
  {
    id: "loading-skeleton",
    split: "dev",
    expect: { load: ["stuck_loading"] },
    tolerate: ["empty_content"],
    title: "Dashboard",
    body: `<h1>Dashboard</h1><p>Loading your dashboard</p><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`,
  },
  {
    id: "loading-please-wait",
    split: "heldout",
    expect: { load: ["stuck_loading"] },
    tolerate: ["empty_content"],
    title: "Order history",
    body: `<h1>Order history</h1><p>Please wait while we fetch your orders...</p>`,
  },
  {
    id: "loading-after-click",
    split: "heldout",
    expect: { load: [], action: ["stuck_loading"] },
    tolerate: ["empty_content"],
    title: "Search",
    body: `<h1>Search</h1><label>Query <input value="backpack"></label>${ACT("Search")}<section id="results"><p>Enter a query to search the catalog.</p></section>`,
    script: `document.querySelector('#act').onclick=()=>{${SET("#results", "Searching…")}}`,
  },
  // Empty where content is expected.
  {
    id: "empty-search-results",
    split: "dev",
    expect: { load: ["empty_content"] },
    title: "Search results",
    body: `<h1>Search results for “backpack”</h1><section id="results"></section>`,
  },
  {
    id: "empty-orders-table",
    split: "dev",
    expect: { load: ["empty_content"] },
    title: "Your orders",
    body: `<h1>Your orders</h1><table><thead><tr><th>Order</th><th>Date</th><th>Total</th><th>Status</th></tr></thead><tbody></tbody></table>`,
  },
  {
    id: "empty-product-detail",
    split: "heldout",
    expect: { load: ["empty_content"] },
    title: "Product details",
    body: `<h1>Product details</h1><section><h2>Description</h2></section><section><h2>Specifications</h2></section>`,
  },
  {
    id: "empty-dashboard",
    split: "heldout",
    expect: { load: ["empty_content"] },
    title: "Dashboard",
    body: `<h1>Dashboard</h1><section><h2>Recent activity</h2></section><section><h2>Notifications</h2></section>`,
  },
  // Broken values that an exact string catches.
  {
    id: "value-undefined",
    split: "dev",
    expect: { load: ["broken_value"] },
    title: "Account",
    body: `<h1>Hello, undefined!</h1><p>Member since 2024</p><p>Email: sam@example.com</p>`,
  },
  {
    id: "value-nan",
    split: "dev",
    expect: { load: ["broken_value"] },
    title: "Cart",
    body: `<h1>Cart</h1><ul><li>Canvas Backpack $29.00</li><li>Trail Light $9.00</li></ul><p>Total: $NaN</p>`,
  },
  {
    id: "value-object",
    split: "heldout",
    expect: { load: ["broken_value"] },
    title: "Shipping",
    body: `<h1>Shipping</h1><p>Ship to: [object Object]</p><button>Continue</button>`,
  },
  {
    id: "value-template",
    split: "heldout",
    expect: { load: ["broken_value"] },
    title: "Welcome",
    body: `<h1>Welcome back, {{user.firstName}}</h1><p>You have 2 items in your cart.</p>`,
  },
  {
    id: "value-invalid-date",
    split: "heldout",
    expect: { load: ["broken_value"] },
    title: "Order #1042",
    body: `<h1>Order #1042</h1><p>Placed on Invalid Date</p><p>Total $41.00</p>`,
  },
  // Broken values only the model can catch.
  {
    id: "fuzzy-blank-price",
    split: "dev",
    expect: { load: ["broken_value"] },
    title: "Canvas Backpack",
    body: `<h1>Canvas Backpack</h1><p>Price: $</p><button>Add to cart</button>`,
  },
  {
    id: "fuzzy-missing-name",
    split: "dev",
    expect: { load: ["broken_value"] },
    title: "Account",
    body: `<h1>Hello , welcome back!</h1><p>Your last order shipped on 12 Oct 2026.</p>`,
  },
  {
    id: "fuzzy-i18n-key",
    split: "heldout",
    expect: { load: ["broken_value"] },
    title: "Checkout",
    body: `<h1>Checkout</h1><p>checkout.summary.total_label $38.00</p><button>checkout.button.place_order</button>`,
  },
  {
    id: "fuzzy-negative-qty",
    split: "heldout",
    expect: { load: ["broken_value"] },
    title: "Cart",
    body: `<h1>Cart</h1><p>You have -3 items in your cart.</p><ul><li>Canvas Backpack $29.00</li></ul>`,
  },
  {
    id: "fuzzy-null-address",
    split: "dev",
    expect: { load: ["broken_value"] },
    title: "Shipping",
    body: `<h1>Shipping</h1><p>Ship to: null, null</p><p>Delivery in 3-5 days</p>`,
  },
  {
    id: "fuzzy-after-click",
    split: "heldout",
    expect: { load: [], action: ["broken_value"] },
    title: "Cart",
    body: `<h1>Cart</h1><ul><li>Canvas Backpack $29.00</li></ul>${ACT("Update total")}<p id="total">Total: $29.00</p>`,
    script: `document.querySelector('#act').onclick=()=>{${SET("#total", "Total: $")}}`,
  },
  // Clean controls for the page checks.
  {
    id: "clean-products",
    split: "dev",
    expect: { load: [] },
    title: "Products",
    body: PRODUCTS,
  },
  {
    id: "clean-orders",
    split: "dev",
    expect: { load: [] },
    title: "Your orders",
    body: ORDERS_TABLE,
  },
  {
    id: "clean-account",
    split: "heldout",
    expect: { load: [] },
    title: "Account",
    body: `<h1>Hello, Sam!</h1><p>Member since 2024</p><p>Email: sam@example.com</p><button>Edit profile</button>`,
  },
  {
    id: "clean-bad-password",
    split: "dev",
    expect: { load: [], action: [] },
    title: "Sign in",
    body: `<h1>Sign in</h1><form onsubmit="return false"><label>Email <input value="sam@example.com"></label><label>Password <input type="password" value="x"></label></form>${ACT("Sign in")}<p id="msg" role="alert"></p>`,
    script: `document.querySelector('#act').onclick=()=>{${SET("#msg", "Invalid email or password.")}}`,
  },
  {
    id: "clean-required-fields",
    split: "heldout",
    expect: { load: [], action: [] },
    title: "Contact us",
    body: `<h1>Contact us</h1><label>Email <input></label><label>Message <textarea></textarea></label>${ACT("Send")}<p id="msg" role="alert"></p>`,
    script: `document.querySelector('#act').onclick=()=>{${SET("#msg", "Email is required. Message is required.")}}`,
  },
  {
    id: "clean-help-errors",
    split: "dev",
    expect: { load: [] },
    title: "Help: troubleshooting",
    body: `<h1>Troubleshooting</h1><article><h2>I see “Something went wrong”</h2><p>This message appears when your connection drops during checkout. Refresh the page and try again; your cart is saved.</p></article><article><h2>My payment failed</h2><p>Check that your card details are correct, or try another card.</p></article>`,
  },
  {
    id: "clean-js-docs",
    split: "heldout",
    expect: { load: [] },
    title: "typeof - JavaScript guide",
    body: `<h1>The typeof operator</h1><p>typeof returns a string naming the type of its operand. For a variable that was declared but never assigned, typeof returns "undefined".</p><p>Dividing zero by zero gives NaN, which typeof reports as "number".</p>`,
  },
  {
    id: "clean-status-page",
    split: "heldout",
    expect: { load: [] },
    title: "System status",
    body: `<h1>All systems operational</h1><section><h2>Past incidents</h2><p>3 Oct 2026 — Elevated error rates on the orders API. Resolved after 14 minutes.</p></section>`,
  },
  {
    id: "clean-empty-cart",
    split: "dev",
    expect: { load: [] },
    title: "Cart",
    body: `<h1>Cart</h1><p>Your cart is empty.</p><a href="/detector/clean-products">Continue shopping</a>`,
  },
  {
    id: "clean-no-results",
    split: "heldout",
    expect: { load: [] },
    title: "Search results",
    body: `<h1>Search results for “zzzz”</h1><p>No products match your search. Try a different word.</p>`,
  },
  {
    id: "clean-zero-values",
    split: "heldout",
    expect: { load: [] },
    title: "Plans",
    body: `<h1>Plans</h1><article><h2>Free</h2><p>$0 / month</p><p>0 team members included</p></article><article><h2>Team</h2><p>$12 / month</p></article>`,
  },
  {
    id: "clean-bakery",
    split: "heldout",
    expect: { load: [] },
    title: "Grandma Nan's Bakery",
    body: `<h1>Grandma Nan's Bakery</h1><p>Sourdough $6.50</p><p>Open daily 7–3. Undefined-hours holidays: call ahead.</p>`,
  },
  {
    id: "clean-loading-resolves",
    split: "dev",
    expect: { load: [] },
    title: "Your orders",
    body: `<h1>Your orders</h1><div id="orders"><p>Loading…</p></div>`,
    script: `setTimeout(()=>{document.querySelector('#orders').innerHTML=${JSON.stringify(ORDERS_TABLE.replace("<h1>Your orders</h1>", ""))}},1200)`,
  },
  {
    id: "clean-checkout-form",
    split: "heldout",
    expect: { load: [] },
    title: "Checkout",
    body: `<h1>Checkout</h1><form><label>First name <input></label><label>Last name <input></label><label>Postal code <input></label><button type="button">Place order</button></form>`,
  },
  {
    id: "clean-order-placed",
    split: "dev",
    expect: { load: [], action: [] },
    title: "Checkout",
    body: `<h1>Checkout</h1><p>Total $38.00</p>${ACT("Place order")}<p id="msg" role="status"></p>`,
    script: `document.querySelector('#act').onclick=()=>{${SET("#msg", "Order #1043 placed. A receipt was sent to sam@example.com.")}}`,
  },
];

export const DETECTOR_CASES: readonly DetectorCase[] = CASES;

/** Allow rules the evaluation passes, as a project would. */
export const DETECTOR_ALLOW = ["http_error:/detector/api/session"] as const;

export interface DetectorResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: string;
  readonly location?: string;
  /** Close the connection without a response, so the request fails at once on every OS. */
  readonly drop?: boolean;
}

const API: Record<string, DetectorResponse> = {
  "/detector/api/ok": {
    status: 200,
    contentType: "application/json",
    body: '{"ok":true}',
  },
  "/detector/api/fail": {
    status: 500,
    contentType: "application/json",
    body: '{"error":"internal"}',
  },
  "/detector/api/session": {
    status: 401,
    contentType: "application/json",
    body: '{"error":"signed out"}',
  },
  "/detector/api/moved": {
    status: 302,
    contentType: "text/plain",
    body: "",
    location: "/detector/api/ok",
  },
  "/detector/api/drop": {
    status: 0,
    contentType: "text/plain",
    body: "",
    drop: true,
  },
};

/** The fixture response for a detector path, or undefined when none. */
export function detectorResponse(
  pathname: string,
): DetectorResponse | undefined {
  if (!pathname.startsWith("/detector/")) return undefined;
  const api = API[pathname];
  if (api) return api;
  const found = CASES.find((item) => pathname === `/detector/${item.id}`);
  if (!found)
    return {
      status: 404,
      contentType: "text/plain",
      body: "Not found",
    };
  return {
    status: found.status ?? 200,
    contentType: "text/html; charset=utf-8",
    body: shell(found.title, found.body, found.script),
  };
}
