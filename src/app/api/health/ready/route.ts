import { getDb } from "@/lib/db/connection";

export async function GET() {
  const headers = { "Cache-Control": "no-store" };

  try {
    const query = { text: "SELECT 1", query_timeout: 2_000 };
    await getDb().query(query);
    return new Response(null, { status: 204, headers });
  } catch {
    return new Response(null, { status: 503, headers });
  }
}
