import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    ok: true,
    marker: "IMOSCAN_DEBUG_OK",
    promptVersion: "IMOSCAN_V3.3.2_BRUTAL",
    now: new Date().toISOString(),
  });
}
