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

create index if not exists bowel_movements_user_occurred_at_idx
  on public.bowel_movements (user_id, occurred_at desc);

alter table public.bowel_movements enable row level security;

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
