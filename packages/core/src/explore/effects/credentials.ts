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
  #typed: Typed | undefined;
  #known: Typed | undefined;
  #signedIn = false;

  /** The account, once a form with a password and an identifier was submitted. */
  get known(): Readonly<Typed> | undefined {
    return this.#known;
  }

  get signedIn(): boolean {
    return this.#signedIn;
  }

  /** A form was filled: remember it when it held a password and an identifier. */
  typed(values: Typed): void {
    const account = values.password && IDENTIFIERS.some((role) => values[role]);
    this.#typed = account ? values : undefined;
  }

  /**
   * The form's submit ran. A form submitted with credentials the run already
   * had signs in; the first one that moved on made the account.
   */
  submitted(progressed: boolean): Submitted {
    const typed = this.#typed;
    this.#typed = undefined;
    if (!typed || !progressed) return undefined;
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
