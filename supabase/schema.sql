create extension if not exists "pgcrypto";

create table if not exists public.meals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  eaten_at timestamptz not null,
  created_at timestamptz not null default now(),
  description text not null,
  restaurant_link text,
  photo_path text,
  photo_file_name text,
  nutrition jsonb not null,
  corrected_nutrition jsonb,
  correction_note text
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

create index if not exists meals_user_eaten_at_idx
  on public.meals (user_id, eaten_at desc);

create index if not exists symptoms_user_occurred_at_idx
  on public.symptoms (user_id, occurred_at desc);

alter table public.meals enable row level security;
alter table public.symptoms enable row level security;

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

drop policy if exists "Users can read own symptoms" on public.symptoms;
create policy "Users can read own symptoms"
  on public.symptoms for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own symptoms" on public.symptoms;
create policy "Users can insert own symptoms"
  on public.symptoms for insert
  with check (auth.uid() = user_id);

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
