import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const configured = {
    allowedEmail: Boolean(
      process.env.APP_ALLOWED_EMAIL || process.env.APP_ALLOWED_EMAILS,
    ),
    openai: Boolean(process.env.OPENAI_API_KEY),
    supabase:
      Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL) &&
      Boolean(process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
  };

  return NextResponse.json({
    configured,
  });
}
