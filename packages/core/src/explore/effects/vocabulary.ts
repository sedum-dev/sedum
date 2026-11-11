/**
 * The closed vocabularies of the effects planner: the only things Jev is
 * asked. Code plans over the answers.
 */

/** What activating a control does. */
export const EFFECTS = {
  navigate_section:
    "Goes to another section, category or page of this site: main navigation, category links, own footer pages",
  open_item_detail: "Opens the page of one listed item",
  add_to_collection:
    "Adds an item to a cart, basket, favourites, list or comparison",
  remove_from_collection:
    "Removes an item from a cart, basket, favourites or list",
  change_quantity: "Changes how many of an item",
  open_collection:
    "Opens the cart, basket, favourites or list the user collected",
  sort_items: "Changes the order of listed items",
  filter_items:
    "Narrows the listed items by a category, brand, price or other criterion",
  search: "Runs a search",
  paginate: "Shows another page of the same list",
  open_form:
    "Opens a form to create, contact, register, review or edit something",
  submit_form: "Submits or saves a form",
  proceed:
    "Moves forward in a multi-step process: checkout, continue, next, confirm, finish, place order, pay",
  sign_in: "Signs in, or opens sign-in or registration",
  toggle_view:
    "Shows, hides or switches part of this page: tabs, accordions, menus, language, theme",
  cancel_or_back: "Cancels or goes back",
  log_out_or_reset: "Logs out, deletes the account or resets the app",
  external:
    "Leaves for another website: social media, documentation, chat, courses",
  other: "Anything else",
} as const;

export type Effect = keyof typeof EFFECTS;

/** What trying one control of an effect is worth; 0 is never tried. */
export const VALUE: Readonly<Record<Effect, number>> = {
  navigate_section: 3,
  open_item_detail: 2,
  add_to_collection: 3,
  remove_from_collection: 1,
  change_quantity: 1.5,
  open_collection: 3,
  sort_items: 1.5,
  filter_items: 1.5,
  search: 2,
  paginate: 1,
  open_form: 3,
  submit_form: 4,
  proceed: 5,
  sign_in: 1,
  toggle_view: 1,
  cancel_or_back: 0.3,
  log_out_or_reset: 0,
  external: 0,
  other: 0.3,
};

/** Forward steps: worth more the deeper they are, and never decayed. */
export const FORWARD: ReadonlySet<Effect> = new Set(["proceed", "submit_form"]);

/** Chrome effects: one control site-wide, wherever it shows. */
export const GLOBAL: ReadonlySet<Effect> = new Set([
  "navigate_section",
  "toggle_view",
  "sign_in",
  "open_collection",
  "external",
  "other",
  "cancel_or_back",
  "log_out_or_reset",
]);

/** Effects that need the form on the page filled first. */
export const NEEDS_FORM: ReadonlySet<Effect> = new Set([
  "submit_form",
  "proceed",
  "search",
]);

/** What must already hold for a forward step to make progress. */
export const GATES = {
  add_items: "The cart, basket or list must contain items first",
  sign_in: "The user must sign in first",
  complete_fields: "Required fields are empty or invalid",
  choose_option: "An option, method or checkbox must be chosen first",
  nothing: "Nothing blocks it, or it cannot be told",
} as const;

export type Gate = keyof typeof GATES;

/** What a form field asks for. */
export const FIELD_ROLES = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  email: "Email",
  username: "A user name or login name that is not an email address",
  password: "Password",
  phone: "Phone",
  street: "Street or address line",
  house_number: "House number",
  postal_code: "Postal or zip code",
  city: "City",
  state: "State or province",
  country: "Country",
  date: "A date",
  number: "A number or amount",
  card_number: "Payment card number",
  card_expiry: "Card expiry",
  card_cvv: "Card security code",
  account_number: "Bank account number",
  search_term: "Search words",
  message: "A message or comment",
  subject: "A subject or title",
  other: "Anything else",
} as const;

export type FieldRole = keyof typeof FIELD_ROLES;

/** A valid value per field role. */
export const FIELD_VALUES: Readonly<Record<FieldRole, string>> = {
  first_name: "Ada",
  last_name: "Lovelace",
  full_name: "Ada Lovelace",
  email: "ada.lovelace@example.com",
  username: "ada_lovelace",
  password: "Sedum-Explore-42!",
  phone: "0612345678",
  street: "Main Street 1",
  house_number: "12",
  postal_code: "1234AB",
  city: "Amsterdam",
  state: "Noord-Holland",
  country: "Netherlands",
  date: "1990-05-17",
  number: "3",
  card_number: "0000-0000-0000-0000",
  card_expiry: "12/2030",
  card_cvv: "123",
  account_number: "12345678",
  search_term: "test",
  message:
    "This is a test message about a product question. It is long enough for forms that ask for a detailed description.",
  subject: "Question",
  other: "Sample",
};

/** Whether activating a control has a lasting effect (asked with --safe). */
export const DESTRUCTIVE = {
  yes: "It has a lasting effect beyond this page that cannot simply be undone: it deletes, removes, revokes, cancels, resets or overwrites data or access; closes an account; pays money; sends something to other people; or signs the user out.",
  no: "It only navigates, opens or closes a view, reads, searches, filters, toggles a display setting, adds to a list, or it can be undone.",
} as const;

/** A label below this confidence becomes "other". */
export const ACCEPT = 0.5;

export function isEffect(value: string): value is Effect {
  return Object.hasOwn(EFFECTS, value);
}
