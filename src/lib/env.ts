type RequiredServerEnv =
  | "NEXT_PUBLIC_SUPABASE_ANON_KEY"
  | "NEXT_PUBLIC_SUPABASE_URL"
  | "OPENAI_API_KEY";

const requiredServerEnv: RequiredServerEnv[] = [
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "NEXT_PUBLIC_SUPABASE_URL",
  "OPENAI_API_KEY",
] ;

export function getEnv(name: RequiredServerEnv) {
  if (!requiredServerEnv.includes(name)) {
    throw new Error(`Unsupported required environment variable: ${name}`);
  }

  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

export function getOptionalEnv(name: string) {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

export function getBaseUrl(request: Request) {
  const configured = getOptionalEnv("NEXT_PUBLIC_APP_URL");

  if (configured) {
    return configured.replace(/\/$/, "");
  }

  const url = new URL(request.url);
  return url.origin;
}
