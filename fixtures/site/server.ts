import { createServer, type Server } from "node:http";

export interface FixtureSite {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function page(title: string, body: string, script = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{font:16px system-ui;max-width:800px;margin:2rem auto}label{display:block;margin:.5rem 0}article{border:1px solid #aaa;padding:1rem;margin:1rem 0}button,a{margin:.25rem}</style></head><body><main>${body}</main><script>${script}</script></body></html>`;
}

const pages: Record<string, string> = {
  "/login": page(
    "Fixture login",
    `<h1>Sign in</h1><form id="login"><label>Username <input name="username" autocomplete="off"></label><label>Password <input name="password" type="password"></label><button type="submit">Login</button></form><p id="message" role="status"></p>`,
    `document.querySelector('#login').addEventListener('submit',event=>{event.preventDefault();const data=new FormData(event.currentTarget);if(data.get('username')==='fixture_user'&&data.get('password')==='fixture_password'){sessionStorage.setItem('signed-in','yes');location.href='/products'}else document.querySelector('#message').textContent='Invalid credentials'})`,
  ),
  "/products": page(
    "Fixture products",
    `<h1>Products</h1><article><h2>Canvas Backpack</h2><p>Price $29</p><button data-product="Canvas Backpack">Add to cart</button></article><article><h2>Trail Light</h2><p>Price $9</p><button data-product="Trail Light">Add to cart</button></article><a href="/cart">Cart</a><p id="message" role="status"></p>`,
    `if(sessionStorage.getItem('signed-in')!=='yes')location.href='/login';document.querySelectorAll('[data-product]').forEach(button=>button.addEventListener('click',()=>{const cart=JSON.parse(sessionStorage.getItem('cart')||'[]');cart.push(button.dataset.product);sessionStorage.setItem('cart',JSON.stringify(cart));document.querySelector('#message').textContent=button.dataset.product+' added to cart'}))`,
  ),
  "/cart": page(
    "Fixture cart",
    `<h1>Cart</h1><ul id="items"></ul><a href="/checkout">Checkout</a>`,
    `if(sessionStorage.getItem('signed-in')!=='yes')location.href='/login';for(const item of JSON.parse(sessionStorage.getItem('cart')||'[]')){const li=document.createElement('li');li.textContent=item;document.querySelector('#items').append(li)}`,
  ),
  "/checkout": page(
    "Fixture checkout",
    `<h1>Checkout</h1><form id="checkout"><label>First name <input name="first" required></label><label>Last name <input name="last" required></label><label>Postal code <input name="postal" required></label><button type="submit">Place order</button></form><p id="confirmation" role="status"></p>`,
    `if(sessionStorage.getItem('signed-in')!=='yes')location.href='/login';document.querySelector('#checkout').addEventListener('submit',event=>{event.preventDefault();document.querySelector('#confirmation').textContent='Order placed';sessionStorage.removeItem('cart')})`,
  ),
  "/duplicate-links": page(
    "Fixture duplicate links",
    `<h1>Help</h1><article><h2>Shipping</h2><a href="/shipping">Read more</a></article><article><h2>Returns</h2><a href="/returns">Read more</a></article>`,
  ),
  "/shipping": page("Shipping", "<h1>Shipping details</h1>"),
  "/returns": page("Returns", "<h1>Returns details</h1>"),
};

function timedPage(route: string, delay: number): string {
  if (route === "/slow")
    return page(
      "Fixture slow page",
      `<h1>Slow page</h1><p id="status">Loading</p><button id="once">Submit once</button><p id="result"></p>`,
      `window.actionCount=0;setTimeout(()=>{document.querySelector('#status').textContent='Ready'},${delay});document.querySelector('#once').addEventListener('click',()=>{window.actionCount++;setTimeout(()=>{document.querySelector('#result').textContent='Saved'},${delay})})`,
    );
  return page(
    "Fixture rerender",
    `<h1>Rerendering list</h1><ul id="list"><li><button>Open record</button></li></ul><p id="result"></p>`,
    `window.actionCount=0;window.rerenderNow=()=>{document.querySelector('#list').innerHTML='<li><button>Open record</button></li>';document.querySelector('#list').dataset.ready='true';document.querySelector('#list button').addEventListener('click',()=>{window.actionCount++;document.querySelector('#result').textContent='Record opened'})};setTimeout(window.rerenderNow,${delay})`,
  );
}

/** A private, ephemeral HTTP site for browser-backed engine tests. */
export async function startFixtureSite(): Promise<FixtureSite> {
  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.local");
    const requestedDelay = Number(url.searchParams.get("delay") ?? 250);
    const delay = Number.isInteger(requestedDelay)
      ? Math.max(0, Math.min(requestedDelay, 2_000))
      : 250;
    const body =
      url.pathname === "/slow" || url.pathname === "/rerender"
        ? timedPage(url.pathname, delay)
        : pages[url.pathname];
    response.writeHead(body === undefined ? 404 : 200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(body ?? page("Not found", "<h1>Not found</h1>"));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No fixture port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
