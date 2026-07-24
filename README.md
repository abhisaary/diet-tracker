# Diet Tracker

A personal, single-user meal and gut symptom tracker. The web UI is designed for
both phone and Mac use: log meal photos plus a quick description, let OpenAI
vision estimate rough macros, and save meal, symptom, and nutrition records to
Supabase.

## Getting Started

1. Copy the environment template:

```bash
cp .env.example .env.local
```

2. Create a Supabase project.

In the Supabase SQL editor, run `supabase/schema.sql`. This creates:

- `meals` table
- `symptoms` table
- private `meal-photos` storage bucket
- row-level security policies for signed-in users

For an existing project, also run new SQL files in `supabase/migrations` in
filename order. The multi-photo migration preserves existing single-photo meal
records.

3. Configure Supabase Auth.

Enable email/password sign-ins in Supabase Auth. In Supabase Auth URL settings,
add your local and deployed URLs:

```text
http://localhost:3000
https://diet-tracker-lyart-ten.vercel.app
```

4. Fill in `.env.local`.

Required variables:

- `NEXT_PUBLIC_SUPABASE_URL`: Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`: Supabase anon key.
- `APP_ALLOWED_EMAILS`: comma-separated emails allowed to use the API.
  `APP_ALLOWED_EMAIL` is still supported for a single email.
- `OPENAI_API_KEY`: OpenAI API key for meal photo analysis.
- `NEXT_PUBLIC_APP_URL`: app URL for the current environment.
- `SUPABASE_SERVICE_ROLE_KEY`: server-only key used by the scheduled reminder
  dispatcher.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT`:
  Web Push credentials.
- `NOTIFICATION_CRON_SECRET`: shared secret used to authenticate scheduled
  reminder dispatches.

5. Run the app:

```bash
npm run dev
```

6. Open [http://localhost:3000](http://localhost:3000), create an account with
   a configured allowed email, then sign in and log a meal or symptom.

## Storage Model

Supabase is the source of truth:

- `meals`: meal descriptions, timestamps, ordered photo path arrays, nutrition
  estimates, assumptions, and optional correction fields. Legacy single-photo
  columns remain populated for compatibility.
- `meal_submissions`: durable processing state for meal estimates, allowing
  interrupted clients to reconnect without showing a false failure.
- `symptoms`: independent timestamped symptom notes with severity, tags, and
  optional duration.
- `bowel_movements`: timestamped bowel movement logs with optional notes,
  private photos, and non-diagnostic image summaries.
- `notification_settings`: each user's meal reminder schedule and timezone.
- `push_subscriptions`: private per-device Web Push subscriptions.
- `reminder_deliveries`: idempotency and delivery status for scheduled
  reminders.
- `meal-photos`: private storage bucket for uploaded meal photos. A meal can
  include up to six photos, all of which are used for nutrition estimation.
  Authenticated browsers upload the original files directly to this bucket;
  the meal API receives only their private storage paths, avoiding serverless
  request-size limits.

OpenAI estimates are intentionally stored as estimates with confidence,
assumptions, portion notes, notable ingredients, and broad possible trigger
categories. Reports are recomputed from raw Supabase records.

## Notes

- This version uses a simple allowed-email gate on API requests. Supabase rows
  are still user-scoped, so allowing a second email does not mix user data.
- Supabase may require email confirmation on account creation depending on your
  Auth settings.
- The OpenAI API key stays on the server side.
- Macro numbers are ballpark estimates for high-level trends, not precise diet
  tracking.
- Possible trigger associations are early heuristics, not medical guidance.

## Deploying

When deploying on Vercel, set these environment variables in the Vercel project:

```text
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
APP_ALLOWED_EMAIL
APP_ALLOWED_EMAILS
OPENAI_API_KEY
NEXT_PUBLIC_APP_URL
OPENAI_MODEL
SUPABASE_SERVICE_ROLE_KEY
NEXT_PUBLIC_VAPID_PUBLIC_KEY
VAPID_PRIVATE_KEY
VAPID_SUBJECT
NOTIFICATION_CRON_SECRET
```

For the current Vercel app:

```text
NEXT_PUBLIC_APP_URL=https://diet-tracker-lyart-ten.vercel.app
OPENAI_MODEL=gpt-5.5
```

After changing Vercel environment variables, redeploy the app.

The push-notification migration creates a Supabase Cron job that runs every
minute. Store the production app URL and the same cron secret in Supabase Vault
under `notification_dispatch_url` and `notification_cron_secret`. On iPhone,
Web Push requires iOS 16.4 or newer and the app must be launched from its Home
Screen icon. Local notification testing also requires HTTPS.
