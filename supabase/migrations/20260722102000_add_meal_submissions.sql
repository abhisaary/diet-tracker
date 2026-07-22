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

create index if not exists meal_submissions_user_status_created_at_idx
  on public.meal_submissions (user_id, status, created_at desc);

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

alter table public.meal_submissions enable row level security;

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
