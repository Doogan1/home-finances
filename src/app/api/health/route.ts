import { connection } from "next/server";
import { ConfigError, getServerConfig } from "@/lib/config";

// Readiness check. Reports only whether the app is ready to serve, never any
// configuration values or database connection details.
export async function GET() {
  // With Cache Components enabled, a GET handler that touches no request data
  // is prerendered at build time, which would freeze the answer to whatever the
  // build environment looked like. `connection()` opts this route into
  // request-time rendering.
  await connection();

  try {
    getServerConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return Response.json(
        { status: "misconfigured" },
        { status: 503, headers: { "Cache-Control": "no-store" } },
      );
    }
    throw error;
  }

  return Response.json({ status: "ok" }, { headers: { "Cache-Control": "no-store" } });
}
