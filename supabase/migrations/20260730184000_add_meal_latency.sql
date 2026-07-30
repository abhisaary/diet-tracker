create table if not exists public.meal_latency (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  meal_id uuid,
  operation text not null
    check (operation in ('create', 'edit')),
  outcome text not null
    check (outcome in ('success', 'error')),
  total_ms double precision not null,
  stages jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  client_total_ms double precision,
  client_stages jsonb,
  created_at timestamptz not null default now(),
  unique (request_id)
);

create index if not exists meal_latency_user_created_at_idx
  on public.meal_latency (user_id, created_at desc);

create index if not exists meal_latency_meal_id_idx
  on public.meal_latency (meal_id)
  where meal_id is not null;

alter table public.meal_latency enable row level security;

drop policy if exists "Users can read own meal latency"
  on public.meal_latency;
create policy "Users can read own meal latency"
  on public.meal_latency for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own meal latency"
  on public.meal_latency;
create policy "Users can insert own meal latency"
  on public.meal_latency for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own meal latency"
  on public.meal_latency;
create policy "Users can update own meal latency"
  on public.meal_latency for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
