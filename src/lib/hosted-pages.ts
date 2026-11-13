import { notFound } from "next/navigation";
import { connection } from "next/server";

import { isHostedMode } from "./utils/env.ts";

/**
 * For pages that only exist when SignuDoc runs as a public service under its
 * own name: the landing page's legal pages and the contact form. On any
 * other install they are not found, and the organization links to its own.
 */
export async function requireHostedMode() {
  // Decided when the page is requested, not when the app was built, so the
  // same build works with HOSTED_MODE on or off.
  await connection();

  if (!isHostedMode()) {
    notFound();
  }
}
