import { describe, expect, it } from "vitest";
import type { Candidate } from "../../page-protocol.js";
import type { Observation } from "../observe.js";
import { Credentials } from "./credentials.js";
import { valueFor } from "./form-fill.js";
import { DeadControls } from "./liveness.js";
import { decay, score, StateMap } from "./state-map.js";
import { foldName, onStartOrigin, pageTemplate } from "./template.js";
import {
  Chrome,
  controlClasses,
  forwardNames,
  pageView,
  stateKey,
  type ControlClass,
  type PageView,
} from "./view.js";
import type { Effect } from "./vocabulary.js";

function candidate(name: string, extra: Partial<Candidate> = {}): Candidate {
  const { signals, ...rest } = extra;
  return {
    ref: `r-${name}-${Math.random()}`,
    tag: signals?.href ? "a" : "button",
    role: signals?.href ? "link" : "button",
    name,
    peers: [],
    editable: false,
    disabled: false,
    inputType: "",
    ...rest,
    signals: { path: name, ...signals },
  };
}

const link = (name: string, href: string, location?: string) =>
  candidate(name, {
    signals: { path: name, href },
    ...(location ? { location } : {}),
  });

function observation(
  url: string,
  clicks: Candidate[],
  fills: Candidate[] = [],
  text = "",
): Observation {
  return {
    url,
    route: new URL(url).pathname,
    title: "",
    text,
    version: {
      document: "d",
      revision: 1,
      route: url,
    } as Observation["version"],
    clicks,
    fills,
    disabled: [],
    state: `${url}\n${text}`,
  };
}

const ORIGIN = "https://shop.example";

describe("page templates", () => {
  it("folds numbers, UUIDs, ULIDs and dashed ids, but not slugs", () => {
    expect(pageTemplate(`${ORIGIN}/product/01J9ZQ3W5V8X7R6T5Y4K3M2N1P`)).toBe(
      "/product/:id",
    );
    expect(
      pageTemplate(
        `${ORIGIN}/orders/3f2b8c1e-9a4d-4c2b-8e7f-1a2b3c4d5e6f/edit`,
      ),
    ).toBe("/orders/:id/edit");
    expect(pageTemplate(`${ORIGIN}/item/ab12-cd34-ef56`)).toBe("/item/:id");
    expect(pageTemplate(`${ORIGIN}/page/2`)).toBe("/page/:id");
    expect(pageTemplate(`${ORIGIN}/category/hand-tools`)).toBe(
      "/category/hand-tools",
    );
    expect(pageTemplate(`${ORIGIN}/product/combination-pliers`)).toBe(
      "/product/combination-pliers",
    );
  });

  it("gives two records of a kind one template and keeps other routes apart", () => {
    const a = pageTemplate(
      `${ORIGIN}/orders/3f2b8c1e-9a4d-4c2b-8e7f-1a2b3c4d5e6f`,
    );
    const b = pageTemplate(
      `${ORIGIN}/orders/9c8d7e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f`,
    );
    expect(a).toBe(b);
    expect(pageTemplate(`${ORIGIN}/orders/new`)).not.toBe(a);
  });

  it("drops the query and plain anchors but keeps hash routes", () => {
    expect(pageTemplate(`${ORIGIN}/prod.html?idp_=3`)).toBe("/prod.html");
    expect(pageTemplate(`${ORIGIN}/about#team`)).toBe("/about");
    expect(pageTemplate(`${ORIGIN}/#/product/42?tab=2`)).toBe("/#/product/:id");
  });

  it("scopes to the start origin, not the registrable domain", () => {
    const base = "https://www.demoblaze.com/index.html";
    const origin = "https://www.demoblaze.com";
    expect(
      onStartOrigin("https://hls.demoblaze.com/index.html", base, origin),
    ).toBe(false);
    expect(onStartOrigin("cart.html", base, origin)).toBe(true);
    expect(onStartOrigin("javascript:void(0)", base, origin)).toBe(true);
    expect(onStartOrigin("mailto:help@demoblaze.com", base, origin)).toBe(
      false,
    );
  });

  it("folds digits in names", () => {
    expect(foldName("Item 12")).toBe(foldName("Item 3"));
    expect(foldName("Item 12")).not.toBe(foldName("Items"));
  });
});

describe("state keys", () => {
  it("ignore field order and digits but split on the step's forward controls", () => {
    expect(stateKey("/checkout", ["Email", "Name"], ["Proceed"])).toBe(
      stateKey("/checkout", ["Name", "Email"], ["Proceed"]),
    );
    expect(stateKey("/x", ["Line 1"], [])).toBe(stateKey("/x", ["Line 2"], []));
    expect(stateKey("/checkout", [], ["Proceed to checkout"])).not.toBe(
      stateKey("/checkout", [], ["Confirm"]),
    );
  });

  it("count forward controls of this step only, not chrome or page numbers", () => {
    const chrome = new Chrome();
    const proceed: ControlClass = control("Proceed");
    const pay: ControlClass = control("Pay now");
    const page2: ControlClass = control("2");
    for (const t of ["/a", "/b", "/c"]) chrome.note(t, [proceed]);
    chrome.note("/checkout", [pay, page2]);
    const effects = new Map<ControlClass, Effect>([
      [proceed, "proceed"],
      [pay, "submit_form"],
      [page2, "proceed"],
    ]);
    expect(
      forwardNames([proceed, pay, page2], (c) => effects.get(c), chrome),
    ).toEqual(["Pay now"]);
  });
});

function control(name: string): ControlClass {
  return {
    labelKey: `button|${name}|`,
    members: [candidate(name)],
    record: false,
    hrefTemplate: "",
  };
}

describe("control classes", () => {
  it("group distinct links of one template as a record, not same-href menus", () => {
    const page = observation(`${ORIGIN}/`, [
      link("Pliers", "/product/01J9ZQ3W5V8X7R6T5Y4K3M2N1P", "main"),
      link("Hammer", "/product/01J9ZQ3W5V8X7R6T5Y4K3M2N1Q", "main"),
      link("Phones", "#", "nav"),
      link("Laptops", "#", "nav"),
      link("Help", "https://docs.example/help"),
    ]);
    const classes = controlClasses(page, ORIGIN);
    const record = classes.find((c) => c.record);
    expect(record?.members.map((m) => m.name)).toEqual(["Pliers", "Hammer"]);
    expect(
      classes.filter((c) => !c.record).map((c) => c.members[0]!.name),
    ).toEqual(["Phones", "Laptops"]);
  });

  it("give chrome one key on every page and records two tries", () => {
    const chrome = new Chrome();
    const effect = (c: ControlClass): Effect =>
      c.record ? "open_item_detail" : "navigate_section";
    const keys = ["/", "/about", "/contact"].map((path) => {
      const page = observation(`${ORIGIN}${path}`, [link("Cart", "#", "nav")]);
      return pageView(page, controlClasses(page, ORIGIN), effect, chrome)
        .affordances[0]!.key;
    });
    expect(new Set(keys).size).toBe(1);
    const list = observation(`${ORIGIN}/`, [
      link("Pliers", "/product/1"),
      link("Hammer", "/product/2"),
    ]);
    const view = pageView(list, controlClasses(list, ORIGIN), effect, chrome);
    expect(view.affordances).toHaveLength(1);
    expect(view.affordances[0]!.instances).toBe(2);
  });
});

describe("scoring", () => {
  const base = { boost: 1, depth: 0, decay: 1, jitter: 0, distance: 0 };

  it("grows forward steps with depth and leaves other steps alone", () => {
    expect(score({ ...base, effect: "proceed", depth: 5 })).toBeCloseTo(10);
    expect(
      score({ ...base, effect: "navigate_section", depth: 5 }),
    ).toBeCloseTo(3);
  });

  it("divides by travel and multiplies boost, decay and jitter", () => {
    expect(score({ ...base, effect: "open_form", distance: 1 })).toBeCloseTo(
      3 / 1.7,
    );
    expect(
      score({
        ...base,
        effect: "add_to_collection",
        boost: 3,
        decay: 0.5,
        jitter: 1,
      }),
    ).toBeCloseTo(3 * 3 * 0.5 * 1.3);
    expect(score({ ...base, effect: "external" })).toBe(0);
  });

  it("decays repeated kinds, but never forward or site-wide controls", () => {
    expect(decay("filter_items", 2)).toBeCloseTo(0.1225);
    expect(decay("filter_items", 0)).toBe(1);
    expect(decay("proceed", 4)).toBe(1);
    expect(decay("navigate_section", 4)).toBe(1);
    expect(decay("toggle_view", 1)).toBeCloseTo(0.35);
  });
});

function view(
  template: string,
  key: string,
  offers: [string, Effect, string?][],
  instances = 1,
): PageView {
  return {
    url: `${ORIGIN}${template}`,
    template,
    stateKey: key,
    snapshot: key,
    controls: [],
    affordances: offers.map(([affordance, effect, cls]) => ({
      key: affordance,
      effect,
      cls: cls ?? `${effect}|${affordance}`,
      instances,
      control:
        instances > 1
          ? {
              ...control(affordance),
              record: true,
              members: [1, 2, 3, 4].map((n) => candidate(`${affordance} ${n}`)),
            }
          : control(affordance),
    })),
  };
}

describe("the state map", () => {
  const still = () => 0;

  it("plans over the whole map and travels by URL when no path is known", () => {
    const map = new StateMap();
    const here = map.learn(view("/list", "list", [["sort", "sort_items"]]), 0);
    map.learn(view("/cart", "cart", [["checkout", "proceed"]]), 1);
    const choice = map.plan(here.key, still)!;
    expect(choice.key).toBe("checkout");
    expect(choice.route.load?.key).toBe("cart");
    expect(choice.route.path).toEqual([]);
    expect(choice.route.distance).toBe(1);
  });

  it("replays a known clean edge but never one that wrote", () => {
    const map = new StateMap();
    const here = map.learn(
      view("/list", "list", [["open-cart", "open_collection"]]),
      0,
    );
    map.learn(view("/cart", "cart", [["checkout", "proceed"]]), 1);
    map.tried("open-cart");
    map.connect("list", "open-cart", "cart", true);
    expect(map.plan(here.key, still)!.route).toMatchObject({
      load: null,
      path: ["open-cart"],
    });
    map.connect("list", "open-cart", "cart", false);
    expect(map.plan(here.key, still)!.route.load?.key).toBe("cart");
    expect(map.plan(here.key, still, { dirty: true })!.route.path).toEqual([
      "open-cart",
    ]);
  });

  it("skips a state that its URL does not restore and no path reaches", () => {
    const map = new StateMap();
    const here = map.learn(view("/list", "list", [["sort", "sort_items"]]), 0);
    const modal = map.learn(
      view("/list", "modal", [["send", "submit_form"]]),
      1,
    );
    modal.restorable = false;
    expect(map.plan(here.key, still)!.key).toBe("sort");
  });

  it("decays a control's class across page templates", () => {
    const map = new StateMap();
    map.learn(
      view("/a", "a", [["a-brand", "filter_items", "filter_items|Brand"]]),
      0,
    );
    const b = map.learn(
      view("/b", "b", [
        ["b-brand", "filter_items", "filter_items|Brand"],
        ["b-page", "paginate"],
      ]),
      0,
    );
    // On /b an untried filter (1.5) beats paging (1), until the Brand
    // filter was tried on /a: then it is worth 1.5 × 0.35.
    expect(map.plan(b.key, still)!.key).toBe("b-brand");
    map.tried("a-brand");
    expect(map.plan(b.key, still)!.key).toBe("b-page");
  });

  it("blocks a page control that could not be used at once", () => {
    const map = new StateMap();
    const here = map.learn(
      view("/", "home", [
        ["tab", "proceed"],
        ["sort", "sort_items"],
      ]),
      0,
    );
    map.tried("tab");
    map.failed("tab");
    expect(map.plan(here.key, still)?.key).toBe("sort");
  });

  it("lets seeds break ties differently", () => {
    const map = new StateMap();
    const here = map.learn(
      view("/", "home", [
        ["first", "open_form"],
        ["second", "open_form", "open_form|other"],
      ]),
      0,
    );
    const draws = [0, 0.9];
    let index = 0;
    expect(map.plan(here.key, () => draws[index++ % 2]!)!.key).toBe("second");
  });
});

describe("field values", () => {
  it("follow the role, the input type and the run's token", () => {
    const context = { token: "77", searchWord: "Pliers" };
    expect(valueFor("city", { type: "text" }, context)).toBe("Amsterdam");
    expect(valueFor("other", { type: "email" }, context)).toBe(
      "ada.lovelace+77@example.com",
    );
    expect(valueFor("number", { type: "number", min: 10 }, context)).toBe("10");
    expect(valueFor("search_term", { type: "search" }, context)).toBe("Pliers");
  });
});

describe("dialogs", () => {
  it("offer only their own controls while open", () => {
    const page = observation(`${ORIGIN}/`, [
      link("Cart", "/cart.html", "navigation, header"),
      candidate("Send message", { location: "dialog, footer · New message" }),
      candidate("Close", { location: "dialog · New message" }),
    ]);
    expect(controlClasses(page, ORIGIN).map((c) => c.members[0]!.name)).toEqual(
      ["Send message", "Close"],
    );
  });

  it("are a state of their own", () => {
    const chrome = new Chrome();
    const behind = observation(`${ORIGIN}/`, [
      link("Cart", "/cart.html", "navigation"),
    ]);
    const open = observation(`${ORIGIN}/`, [
      link("Cart", "/cart.html", "navigation"),
      candidate("Close", { location: "dialog · About us" }),
    ]);
    const key = (o: Observation) =>
      pageView(o, controlClasses(o, ORIGIN), () => "other", chrome).stateKey;
    expect(key(open)).not.toBe(key(behind));
    expect(key(open)).toContain("About us");
  });
});

describe("failing controls", () => {
  it("are given up everywhere once their class failed twice", () => {
    const map = new StateMap();
    const step1 = map.learn(
      view("/checkout", "s1", [["tab-1", "proceed", "proceed|Payment #"]]),
      1,
    );
    map.learn(
      view("/checkout", "s2", [["tab-2", "proceed", "proceed|Payment #"]]),
      2,
    );
    map.tried("tab-1");
    map.failed("tab-1");
    map.tried("tab-1");
    map.failed("tab-1");
    expect(map.plan(step1.key, () => 0)).toBeUndefined();
  });

  it("given up one at a time (a submit left disabled) keep their class open", () => {
    const map = new StateMap();
    const cart = map.learn(
      view("/cart", "cart", [["go-cart", "proceed", "proceed|Continue"]]),
      0,
    );
    for (const [key, step] of [
      ["go-a", "a"],
      ["go-b", "b"],
    ])
      map.learn(
        view(`/${step}`, step!, [[key!, "proceed", "proceed|Continue"]]),
        1,
      );
    map.giveUp("go-a");
    map.giveUp("go-b");
    expect(map.plan(cart.key, () => 0)?.key).toBe("go-cart");
  });
});

describe("re-arming", () => {
  it("opens the collection and its forward steps again after an add", () => {
    const map = new StateMap();
    const list = map.learn(
      view("/list", "list", [["open-cart", "open_collection"]]),
      0,
    );
    map.learn(view("/cart", "cart", [["place-order", "proceed"]]), 1);
    map.learn(view("/about", "about", [["send", "submit_form"]]), 1);
    map.collections.add("/cart");
    for (const key of ["open-cart", "place-order", "send"]) map.tried(key);
    expect(map.plan(list.key, () => 0)).toBeUndefined();
    map.refreshCollection();
    const keys = new Set<string>();
    for (
      let choice = map.plan(list.key, () => 0);
      choice;
      choice = map.plan(list.key, () => 0)
    ) {
      keys.add(choice.key);
      map.tried(choice.key);
    }
    expect([...keys].sort()).toEqual(["open-cart", "place-order"]);
  });

  it("widens lists one record at a time up to the records seen", () => {
    const map = new StateMap();
    const list = map.learn(
      view("/list", "list", [["items", "open_item_detail"]], 2),
      0,
    );
    map.tried("items");
    map.tried("items");
    expect(map.plan(list.key, () => 0)).toBeUndefined();
    expect(map.widen()).toBe(true);
    expect(map.plan(list.key, () => 0)?.key).toBe("items");
    map.tried("items");
    map.widen();
    map.tried("items");
    expect(map.widen()).toBe(false);
  });

  it("forgets an offer the state stopped showing, but keeps it elsewhere", () => {
    const map = new StateMap();
    const home = map.learn(view("/", "home", [["cart", "open_collection"]]), 0);
    map.learn(view("/x", "x", [["cart", "open_collection"]]), 0);
    map.forget("home", "cart");
    const choice = map.plan(home.key, () => 0)!;
    expect(choice.state.key).toBe("x");
  });
});

describe("forward chrome", () => {
  it("is one affordance site-wide, not one per state", () => {
    const chrome = new Chrome();
    const keys = ["/", "/a", "/b", "/c"].map((path) => {
      const page = observation(`${ORIGIN}${path}`, [
        candidate("Next →", { location: "aside" }),
      ]);
      return pageView(
        page,
        controlClasses(page, ORIGIN),
        () => "proceed",
        chrome,
      ).affordances[0]!.key;
    });
    expect(new Set(keys.slice(2)).size).toBe(1);
    expect(keys[3]!.startsWith("*:")).toBe(true);
  });
});

describe("toggle menus", () => {
  it("decay as one class: a second language is worth less than the first", () => {
    const chrome = new Chrome();
    const page = observation(`${ORIGIN}/`, [
      link("EN", "#", "navigation · Select language"),
      link("FR", "#", "navigation · Select language"),
      link("Cart", "/cart", "navigation"),
    ]);
    const effect = (c: ControlClass): Effect =>
      c.members[0]!.name === "Cart" ? "open_collection" : "toggle_view";
    const map = new StateMap();
    const home = map.learn(
      pageView(page, controlClasses(page, ORIGIN), effect, chrome),
      0,
    );
    const first = map.plan(home.key, () => 0)!;
    map.tried(first.key);
    const second = map.plan(home.key, () => 0)!;
    map.tried(second.key);
    const third = map.plan(home.key, () => 0)!;
    expect(
      [first.key, second.key].some((k) => k.includes("open_collection")),
    ).toBe(true);
    expect(third.score).toBeCloseTo(0.35);
  });
});

describe("affordance keys", () => {
  const select = (name: string, options: string[]): ControlClass => ({
    labelKey: `combobox|${name}|`,
    members: [candidate(name, { tag: "select", role: "combobox" })],
    record: false,
    hrefTemplate: "",
    options,
  });

  it("try a sorting dropdown's options, but leave form dropdowns to the filler", () => {
    const chrome = new Chrome();
    const page = observation(`${ORIGIN}/register`, []);
    const sort = select("Sort", ["Name (A - Z)", "Price (High - Low)"]);
    const country = select("Country", ["Albania", "Netherlands"]);
    const effects = new Map<ControlClass, Effect>([
      [sort, "sort_items"],
      [country, "other"],
    ]);
    const shown = pageView(
      page,
      [sort, country],
      (c) => effects.get(c),
      chrome,
    );
    expect(shown.affordances.map((a) => a.option)).toEqual([
      "Name (A - Z)",
      "Price (High - Low)",
    ]);
  });

  it("scope a forward button to its step, but a forward link to its page", () => {
    const chrome = new Chrome();
    const key = (fields: string[], control: ControlClass) =>
      pageView(
        observation(
          `${ORIGIN}/checkout`,
          [],
          fields.map((f) => candidate(f)),
        ),
        [control],
        () => "proceed",
        chrome,
      ).affordances[0]!.key;
    const button = control("Proceed");
    const cartLink: ControlClass = {
      ...control("cart"),
      hrefTemplate: "/checkout",
    };
    expect(key(["Email"], button)).not.toBe(key(["Street"], button));
    expect(key(["Email"], cartLink)).toBe(key(["Street"], cartLink));
  });
});

describe("travel to states a URL does not restore", () => {
  const still = () => 0;

  /** start → step1 → step2 of a wizard that keeps one URL. */
  function wizard(): StateMap {
    const map = new StateMap();
    const start = map.learn(
      view("/", "start", [["go", "navigate_section"]]),
      0,
    );
    const step1 = map.learn(
      view("/checkout", "step1", [["next", "proceed"]]),
      1,
    );
    map.cameFrom(start, step1, `${ORIGIN}/checkout`);
    const step2 = map.learn(
      { ...view("/checkout", "step2", [["pay", "proceed"]]) },
      2,
    );
    map.cameFrom(step1, step2, `${ORIGIN}/checkout`);
    map.tried("go");
    map.tried("next");
    map.connect("start", "go", "step1", true);
    map.connect("step1", "next", "step2", true);
    map.learn(view("/about", "about", []), 1);
    return map;
  }

  it("learns that a state reached at the same URL is not restored by it", () => {
    const map = wizard();
    expect(map.states.get("step1")!.restorable).toBe(true);
    expect(map.states.get("step2")!.restorable).toBe(false);
  });

  it("loads the nearest restorable ancestor and replays the path from it", () => {
    const map = wizard();
    map.states.get("step1")!.restorable = false;
    const choice = map.plan("about", still)!;
    expect(choice.key).toBe("pay");
    expect(choice.route).toMatchObject({
      path: ["go", "next"],
      expect: ["step1", "step2"],
      distance: 3,
    });
    expect(choice.route.load?.key).toBe("start");
  });

  it("does not replay longer paths than allowed", () => {
    const map = wizard();
    map.states.get("step1")!.restorable = false;
    expect(map.plan("about", still, { maxPath: 1 })).toBeUndefined();
  });
});

describe("hysteresis", () => {
  it("finishes the current state's forward steps before going elsewhere", () => {
    const map = new StateMap();
    const here = map.learn(
      view("/form", "form", [
        ["send", "submit_form"],
        ["menu", "toggle_view"],
      ]),
      0,
    );
    map.learn(view("/deep", "deep", [["pay", "proceed"]]), 6);
    const focus = (r: { effect: Effect }) =>
      r.effect === "proceed" || r.effect === "submit_form";
    expect(map.plan(here.key, () => 0)!.key).toBe("pay");
    expect(map.plan(here.key, () => 0, { focus })!.key).toBe("send");
    map.tried("send");
    expect(map.plan(here.key, () => 0, { focus })!.key).toBe("pay");
  });
});

describe("spending the rest of the budget", () => {
  it("sweeps every remaining record and what was not shown, but not dead controls", () => {
    const map = new StateMap();
    const list = map.learn(
      view("/list", "list", [["items", "open_item_detail"]], 2),
      0,
    );
    map.learn(
      view("/list", "list", [
        ["more", "paginate"],
        ["off", "other"],
      ]),
      0,
    );
    map.tried("items");
    map.tried("items");
    map.forget(list.key, "more");
    map.forget(list.key, "off", false);
    expect(map.plan(list.key, () => 0)).toBeUndefined();
    expect(map.sweep()).toBe(true);
    expect(map.records.get("items")!.instances).toBe(4);
    expect(map.states.get("list")!.offers.has("more")).toBe(true);
    expect(map.states.get("list")!.offers.has("off")).toBe(false);
    expect(map.plan(list.key, () => 0)?.key).toBe("more");
  });

  it("re-arms spent records once, but not blocked ones", () => {
    const map = new StateMap();
    const here = map.learn(
      view("/c", "c", [
        ["a", "proceed"],
        ["b", "proceed"],
      ]),
      0,
    );
    map.tried("a");
    map.tried("b");
    map.failed("b");
    expect(map.rearm(["a", "b"])).toBe(true);
    expect(map.plan(here.key, () => 0)?.key).toBe("a");
    expect(map.rearm(["b"])).toBe(false);
  });
});

describe("dead controls", () => {
  it("are dead in a state after two clicks that changed nothing", () => {
    const dead = new DeadControls();
    expect(dead.idle("s1", "tab")).toBe(false);
    expect(dead.dead("s1", "tab")).toBe(false);
    expect(dead.idle("s2", "tab")).toBe(false);
    expect(dead.idle("s1", "tab")).toBe(true);
    expect(dead.dead("s1", "tab")).toBe(true);
    expect(dead.dead("s2", "tab")).toBe(false);
  });
});

describe("credentials", () => {
  const signUp = {
    email: "ada+1@example.com",
    password: "pw",
    first_name: "Ada",
  };

  it("are remembered from a submitted sign-up and used to sign in", () => {
    const credentials = new Credentials();
    credentials.typed("register", signUp);
    expect(credentials.submitted("register", true)).toBe("registered");
    expect(credentials.valueFor("email")).toBe("ada+1@example.com");
    expect(credentials.valueFor("password")).toBe("pw");
    expect(credentials.valueFor("first_name")).toBeUndefined();
    credentials.typed("login", { email: "ada+1@example.com", password: "pw" });
    expect(credentials.submitted("login", true)).toBe("signed_in");
    expect(credentials.signedIn).toBe(true);
  });

  it("survive a rejected submit whose retry refills only some fields", () => {
    const credentials = new Credentials();
    credentials.typed("register", signUp);
    expect(credentials.submitted("register", false)).toBeUndefined();
    credentials.typed("register", { postal_code: "10115" });
    expect(credentials.submitted("register", true)).toBe("registered");
    expect(credentials.valueFor("password")).toBe("pw");
  });

  it("are not taken from another state's submit, or from a form without a password", () => {
    const credentials = new Credentials();
    credentials.typed("register", signUp);
    expect(credentials.submitted("home", true)).toBeUndefined();
    expect(credentials.submitted("register", true)).toBeUndefined();
    credentials.typed("contact", { email: "ada+1@example.com", message: "hi" });
    expect(credentials.submitted("contact", true)).toBeUndefined();
    expect(credentials.known).toBeUndefined();
  });

  it("give a sign-up a username new on every run", () => {
    const one = valueFor("username", { type: "text" }, { token: "1" });
    const two = valueFor("username", { type: "text" }, { token: "2" });
    expect(one).not.toBe(two);
  });
});

describe("controls a page shows", () => {
  const offered = (page: Observation, effect: Effect) =>
    pageView(page, controlClasses(page, ORIGIN), () => effect, new Chrome())
      .affordances;

  it("offer a disabled button only as a submit its form may enable", () => {
    const page = observation(`${ORIGIN}/checkout`, [
      candidate("Proceed", { disabled: true }),
    ]);
    expect(offered(page, "proceed")).toHaveLength(1);
    expect(offered(page, "paginate")).toHaveLength(0);
  });

  it("keep a disabled button out of the class of the same enabled control", () => {
    const page = observation(`${ORIGIN}/list`, [
      candidate("Add to cart", { location: "main", peers: ["Pliers"] }),
      candidate("Add to cart", { location: "main", peers: ["Saw"] }),
      candidate("Proceed"),
      candidate("Add to cart", {
        location: "main",
        peers: ["Drill"],
        disabled: true,
      }),
      candidate("Proceed", { disabled: true }),
    ]);
    const classes = controlClasses(page, ORIGIN);
    expect(
      classes.map((c) => [c.members.length, c.members.some((m) => m.disabled)]),
    ).toEqual([
      [2, false],
      [1, false],
    ]);
  });

  it("never take a link to the page they are on for a forward step", () => {
    const page = observation(`${ORIGIN}/checkout`, [
      link("cart", "/checkout", "navigation"),
    ]);
    expect(offered(page, "proceed").map((a) => a.effect)).toEqual(["other"]);
  });
});
