import type { FieldRole } from "./vocabulary.js";

/** The roles that identify an account. */
const IDENTIFIERS: readonly FieldRole[] = ["email", "username"];

/** What a form was given, by field role. */
export type Typed = Partial<Record<FieldRole, string>>;

/** What a submitted form turned out to be. */
export type Submitted = "registered" | "signed_in" | undefined;

/**
 * The account the run made: the identifiers and password it typed into a
 * form that was submitted and moved on. A later form with a password is
 * signed in to with them.
 */
export class Credentials {
  /** What the form in one state was given, until a submit there moves on. */
  #typed: { readonly state: string; values: Typed } | undefined;
  #known: Typed | undefined;
  #signedIn = false;

  /** The account, once a form with a password and an identifier was submitted. */
  get known(): Readonly<Typed> | undefined {
    return this.#known;
  }

  get signedIn(): boolean {
    return this.#signedIn;
  }

  /**
   * A form in `state` was filled. A refill after a rejected submit adds to
   * what the same form was given before.
   */
  typed(state: string, values: Typed): void {
    const same = this.#typed?.state === state;
    this.#typed = {
      state,
      values: same ? { ...this.#typed!.values, ...values } : values,
    };
  }

  /**
   * A control in `state` ran. A form there submitted with credentials the
   * run already had signs in; the first one that moved on made the account.
   * A submit that did not move on keeps the values for a retry.
   */
  submitted(state: string, progressed: boolean): Submitted {
    const typed = this.#typed;
    if (typed?.state !== state) {
      this.#typed = undefined;
      return undefined;
    }
    if (!progressed) return undefined;
    this.#typed = undefined;
    return isAccount(typed.values) ? this.#account(typed.values) : undefined;
  }

  #account(typed: Typed): Submitted {
    if (this.#known && sameAccount(this.#known, typed)) {
      this.#signedIn = true;
      return "signed_in";
    }
    this.#known = pick(typed);
    return "registered";
  }

  /** The value a field gets when the account has one for its role. */
  valueFor(role: FieldRole): string | undefined {
    return this.#known?.[role];
  }
}

/** A password and an email or username. */
function isAccount(values: Typed): boolean {
  return !!values.password && IDENTIFIERS.some((role) => values[role]);
}

function pick(typed: Typed): Typed {
  const account: Typed = { password: typed.password! };
  for (const role of IDENTIFIERS) if (typed[role]) account[role] = typed[role];
  return account;
}

function sameAccount(known: Typed, typed: Typed): boolean {
  if (known.password !== typed.password) return false;
  return IDENTIFIERS.some(
    (role) => !!typed[role] && typed[role] === known[role],
  );
}
