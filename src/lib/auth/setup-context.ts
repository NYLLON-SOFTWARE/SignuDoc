import { AsyncLocalStorage } from "node:async_hooks";

declare global {
  var __signudocSetupStorage: AsyncLocalStorage<true> | undefined;
}

// First-run setup creates the administrator through the same sign-up code as
// everyone else. While it does, two rules have to stand aside: the sign-up
// rule (there is no administrator yet to have chosen one) and the
// verification email (email cannot work before setup has finished).
//
// Kept on globalThis so the setup route and the auth code read the same
// store even if a bundler gives each its own copy of this module.
const setupStorage = (globalThis.__signudocSetupStorage ??=
  new AsyncLocalStorage<true>());

export function runAsSetup<T>(run: () => Promise<T>): Promise<T> {
  return setupStorage.run(true, run);
}

export function isRunningSetup(): boolean {
  return setupStorage.getStore() === true;
}
