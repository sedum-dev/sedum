import type { LocatorFailure } from "./locator.js";

export class LocatorError extends Error {
  constructor(readonly reason: LocatorFailure) {
    super(reason);
  }
}
