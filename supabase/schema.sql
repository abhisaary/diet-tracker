create extension if not exists "pgcrypto";
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  eaten_at timestamptz not null,
  created_at timestamptz not null default now(),
  description text not null,
  restaurant_link text,
  photo_path text,
  photo_file_name text,
  photo_paths text[] not null default '{}',
  photo_file_names text[] not null default '{}',
  nutrition jsonb not null,
  corrected_nutrition jsonb,
  correction_note text
);

create table if not exists public.meal_submissions (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'processing'
    check (status in ('processing', 'ready', 'failed')),
  submitted_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  description text not null,
  eaten_at timestamptz,
  restaurant_link text,
  timezone text,
  photo_paths text[] not null default '{}',
  photo_file_names text[] not null default '{}',
  error_message text
);

create table if not exists public.symptoms (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  severity integer not null check (severity between 1 and 5),
  duration_minutes integer check (duration_minutes > 0),
  tags text[] not null default '{}',
  note text not null
);

create table if not exists public.bowel_movements (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  note text,
  photo_path text,
  photo_file_name text,
  image_summary text,
  summary_status text not null default 'none'
    check (summary_status in ('none', 'processing', 'ready', 'failed')),
  summary_model text,
  summary_error text,
  summarized_at timestamptz
);

create table if not exists public.notification_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  timezone text not null default 'UTC',
  day_pattern text not null default 'daily'
    check (day_pattern in ('daily', 'weekdays')),
  reminder_times text[] not null default '{}'
    check (cardinality(reminder_times) <= 12),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (endpoint)
);

create table if not exists public.reminder_deliveries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  scheduled_for timestamptz not null,
  reminder_time text not null,
  status text not null default 'processing'
    check (status in ('processing', 'sent', 'failed')),
  sent_subscriptions integer not null default 0,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, scheduled_for)
);

create index if not exists meals_user_eaten_at_idx
  on public.meals (user_id, eaten_at desc);

create index if not exists meal_submissions_user_status_created_at_idx
  on public.meal_submissions (user_id, status, created_at desc);

create index if not exists symptoms_user_occurred_at_idx
  on public.symptoms (user_id, occurred_at desc);

create index if not exists bowel_movements_user_occurred_at_idx
  on public.bowel_movements (user_id, occurred_at desc);

create index if not exists notification_settings_enabled_idx
  on public.notification_settings (enabled)
  where enabled = true;

create index if not exists push_subscriptions_user_id_idx
  on public.push_subscriptions (user_id);

create index if not exists reminder_deliveries_scheduled_for_idx
  on public.reminder_deliveries (scheduled_for desc);

create or replace function public.complete_meal_submission(
  p_id uuid,
  p_description text,
  p_eaten_at timestamptz,
  p_nutrition jsonb,
  p_restaurant_link text,
  p_photo_paths text[],
  p_photo_file_names text[]
)
returns setof public.meals
language plpgsql
security invoker
set search_path = public
as $$
declare
  completed_meal public.meals;
begin
  perform 1
  from public.meal_submissions
  where id = p_id
    and user_id = auth.uid()
    and status = 'processing'
  for update;

  if not found then
    raise exception 'Meal submission is not processing.';
  end if;

  insert into public.meals (
    id,
    user_id,
    eaten_at,
    description,
    restaurant_link,
    photo_path,
    photo_file_name,
    photo_paths,
    photo_file_names,
    nutrition
  )
  values (
    p_id,
    auth.uid(),
    p_eaten_at,
    p_description,
    p_restaurant_link,
    p_photo_paths[1],
    p_photo_file_names[1],
    p_photo_paths,
    p_photo_file_names,
    p_nutrition
  )
  returning * into completed_meal;

  update public.meal_submissions
  set
    status = 'ready',
    error_message = null,
    completed_at = now(),
    updated_at = now()
  where id = p_id
    and user_id = auth.uid();

  return next completed_meal;
end;
$$;

revoke all on function public.complete_meal_submission(
  uuid,
  text,
  timestamptz,
  jsonb,
  text,
  text[],
  text[]
) from public;
grant execute on function public.complete_meal_submission(
  uuid,
  text,
  timestamptz,
  jsonb,
  text,
  text[],
  text[]
) to authenticated;

alter table public.meals enable row level security;
alter table public.meal_submissions enable row level security;
alter table public.symptoms enable row level security;
alter table public.bowel_movements enable row level security;
alter table public.notification_settings enable row level security;
alter table public.push_subscriptions enable row level security;
alter table public.reminder_deliveries enable row level security;

drop policy if exists "Users can read own meals" on public.meals;
create policy "Users can read own meals"
  on public.meals for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own meals" on public.meals;
create policy "Users can insert own meals"
  on public.meals for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own meals" on public.meals;
create policy "Users can update own meals"
  on public.meals for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own meals" on public.meals;
create policy "Users can delete own meals"
  on public.meals for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read own meal submissions"
  on public.meal_submissions;
create policy "Users can read own meal submissions"
  on public.meal_submissions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own meal submissions"
  on public.meal_submissions;
create policy "Users can insert own meal submissions"
  on public.meal_submissions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own meal submissions"
  on public.meal_submissions;
create policy "Users can update own meal submissions"
  on public.meal_submissions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own meal submissions"
  on public.meal_submissions;
create policy "Users can delete own meal submissions"
  on public.meal_submissions for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read own symptoms" on public.symptoms;
create policy "Users can read own symptoms"
  on public.symptoms for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own symptoms" on public.symptoms;
create policy "Users can insert own symptoms"
  on public.symptoms for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can read own bowel movements"
  on public.bowel_movements;
create policy "Users can read own bowel movements"
  on public.bowel_movements for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own bowel movements"
  on public.bowel_movements;
create policy "Users can insert own bowel movements"
  on public.bowel_movements for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own bowel movements"
  on public.bowel_movements;
create policy "Users can update own bowel movements"
  on public.bowel_movements for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own bowel movements"
  on public.bowel_movements;
create policy "Users can delete own bowel movements"
  on public.bowel_movements for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read own notification settings"
  on public.notification_settings;
create policy "Users can read own notification settings"
  on public.notification_settings for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own notification settings"
  on public.notification_settings;
create policy "Users can insert own notification settings"
  on public.notification_settings for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own notification settings"
  on public.notification_settings;
create policy "Users can update own notification settings"
  on public.notification_settings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own notification settings"
  on public.notification_settings;
create policy "Users can delete own notification settings"
  on public.notification_settings for delete
  using (auth.uid() = user_id);

drop policy if exists "Users can read own push subscriptions"
  on public.push_subscriptions;
create policy "Users can read own push subscriptions"
  on public.push_subscriptions for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own push subscriptions"
  on public.push_subscriptions;
create policy "Users can insert own push subscriptions"
  on public.push_subscriptions for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own push subscriptions"
  on public.push_subscriptions;
create policy "Users can update own push subscriptions"
  on public.push_subscriptions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own push subscriptions"
  on public.push_subscriptions;
create policy "Users can delete own push subscriptions"
  on public.push_subscriptions for delete
  using (auth.uid() = user_id);

create or replace function public.upsert_push_subscription(
  p_endpoint text,
  p_p256dh text,
  p_auth text,
  p_user_agent text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  insert into public.push_subscriptions (
    user_id,
    endpoint,
    p256dh,
    auth,
    user_agent,
    updated_at
  )
  values (
    auth.uid(),
    p_endpoint,
    p_p256dh,
    p_auth,
    p_user_agent,
    now()
  )
  on conflict (endpoint) do update
  set
    user_id = auth.uid(),
    p256dh = excluded.p256dh,
    auth = excluded.auth,
    user_agent = excluded.user_agent,
    updated_at = now();
end;
$$;

revoke all on function public.upsert_push_subscription(text, text, text, text)
  from public;
revoke all on function public.upsert_push_subscription(text, text, text, text)
  from anon;
grant execute on function public.upsert_push_subscription(text, text, text, text)
  to authenticated;

insert into storage.buckets (id, name, public)
values ('meal-photos', 'meal-photos', false)
on conflict (id) do nothing;

drop policy if exists "Users can read own meal photos" on storage.objects;
create policy "Users can read own meal photos"
  on storage.objects for select
  using (
    bucket_id = 'meal-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can upload own meal photos" on storage.objects;
create policy "Users can upload own meal photos"
  on storage.objects for insert
  with check (
    bucket_id = 'meal-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can delete own meal photos" on storage.objects;
create policy "Users can delete own meal photos"
  on storage.objects for delete
  using (
    bucket_id = 'meal-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

insert into storage.buckets (id, name, public)
values ('bowel-photos', 'bowel-photos', false)
on conflict (id) do nothing;

drop policy if exists "Users can read own bowel photos" on storage.objects;
create policy "Users can read own bowel photos"
  on storage.objects for select
  using (
    bucket_id = 'bowel-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can upload own bowel photos" on storage.objects;
create policy "Users can upload own bowel photos"
  on storage.objects for insert
  with check (
    bucket_id = 'bowel-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

drop policy if exists "Users can delete own bowel photos" on storage.objects;
create policy "Users can delete own bowel photos"
  on storage.objects for delete
  using (
    bucket_id = 'bowel-photos'
    and auth.uid()::text = (storage.foldername(name))[1]
  );

create or replace function public.invoke_notification_dispatch()
returns void
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  dispatch_secret text;
  dispatch_url text;
begin
  select decrypted_secret
  into dispatch_url
  from vault.decrypted_secrets
  where name = 'notification_dispatch_url'
  limit 1;

  select decrypted_secret
  into dispatch_secret
  from vault.decrypted_secrets
  where name = 'notification_cron_secret'
  limit 1;

  if dispatch_url is null or dispatch_secret is null then
    return;
  end if;

  perform net.http_post(
    url := rtrim(dispatch_url, '/') || '/api/notifications/dispatch',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || dispatch_secret,
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('invokedAt', now()),
    timeout_milliseconds := 10000
  );
end;
$$;

revoke all on function public.invoke_notification_dispatch() from public;
revoke all on function public.invoke_notification_dispatch() from anon;
revoke all on function public.invoke_notification_dispatch() from authenticated;
grant execute on function public.invoke_notification_dispatch() to postgres;

select cron.unschedule(jobid)
from cron.job
where jobname = 'dispatch-meal-reminders';

select cron.schedule(
  'dispatch-meal-reminders',
  '* * * * *',
  'select public.invoke_notification_dispatch();'
);

select cron.unschedule(jobid)
from cron.job
where jobname = 'cleanup-notification-cron-history';

select cron.schedule(
  'cleanup-notification-cron-history',
  '17 3 * * *',
  $$
    delete from cron.job_run_details
    where end_time < now() - interval '7 days';
  $$
);
