alter table public.meals
  add column if not exists photo_paths text[] not null default '{}';

alter table public.meals
  add column if not exists photo_file_names text[] not null default '{}';

update public.meals
set photo_paths = array[photo_path]
where photo_path is not null
  and cardinality(photo_paths) = 0;

update public.meals
set photo_file_names = array[photo_file_name]
where photo_path is not null
  and photo_file_name is not null
  and cardinality(photo_file_names) = 0;
