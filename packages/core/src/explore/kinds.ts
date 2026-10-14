/** Page kinds for coverage. Generic, so one list works on any site. */
export const PAGE_KINDS: Readonly<Record<string, string>> = {
  home: "The landing or home page that introduces the site and links to its sections",
  listing: "A list or grid of many items, products, posts or records to browse",
  detail: "The page for one single item, product, post or record",
  search: "A search page or a page of search results",
  form: "A page whose main purpose is a form to fill in and submit, such as sign up, subscribe, contact or edit",
  confirmation:
    "A success or thank-you page shown after submitting or completing something",
  auth: "Sign in, sign up, sign out or password reset",
  account:
    "The user's own account, profile, settings, preferences or saved data",
  admin: "An administration console, dashboard, report or internal tool",
  cart: "A shopping cart, checkout or payment page",
  content:
    "An informational article, help page, policy, terms or documentation",
  error:
    "An error or dead-end page: not found, server error, access denied, deleted or crashed",
  other: "None of the above",
};

/**
 * A model-free safety baseline: words that usually label destructive or
 * irreversible actions.
 */
const DESTRUCTIVE_WORDS =
  /\b(delete|remove|erase|destroy|revoke|cancel|terminate|deactivate|disconnect|archive|close account|unsubscribe|reset|wipe|purge|sign ?out|log ?out|pay|purchase|place order|transfer|send|resend|invite|share)\b/iu;

export function looksDestructive(name: string): boolean {
  return DESTRUCTIVE_WORDS.test(name);
}

/**
 * Targets that would end the walk's own session: logging out, or closing
 * the account it is signed in with. Never clicked, with or without --safe.
 */
const SESSION_ENDING =
  /\b(log ?out|sign ?out|log ?off|sign ?off)\b|\b(delete|close|deactivate|cancel)\s+(my\s+|your\s+|this\s+)?account\b/iu;

export function endsSession(name: string): boolean {
  return SESSION_ENDING.test(name);
}

/** Coverage weight of reaching a kind seen `visits` times before. */
export function novelty(visits: number): number {
  return 1 / Math.sqrt(1 + visits);
}
