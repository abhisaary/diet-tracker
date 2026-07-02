import { createClient } from "@supabase/supabase-js";

export function createBrowserSupabaseClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://example.supabase.co",
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "missing-supabase-anon-key",
  );
}
