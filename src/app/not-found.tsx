import { connection } from "next/server";

import { NotFoundShell } from "@/components/not-found/not-found-shell";

export default async function NotFound() {
  // Rendered for each request, not once at build time, so its scripts
  // carry the nonce the Content-Security-Policy asks for (src/proxy.ts).
  await connection();

  return <NotFoundShell initialState="default" />;
}
