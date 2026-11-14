create table if not exists public.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  full_name text not null default '',
  require_name_change boolean not null default false,
  require_email_change boolean not null default false,
  require_password_change boolean not null default false,
  updated_at timestamptz not null default now()
);

alter table public.user_profiles enable row level security;

revoke all on public.user_profiles from anon, authenticated;
grant select on public.user_profiles to authenticated;
grant update (
  require_name_change,
  require_email_change,
  require_password_change
) on public.user_profiles to authenticated;

drop policy if exists "Users read own profile and admins read all profiles" on public.user_profiles;
create policy "Users read own profile and admins read all profiles"
on public.user_profiles
for select
to authenticated
using (
  id = (select auth.uid())
  or (select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin'
);

drop policy if exists "Admins update required account changes" on public.user_profiles;
create policy "Admins update required account changes"
on public.user_profiles
for update
to authenticated
using ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin')
with check ((select auth.jwt() -> 'app_metadata' ->> 'role') = 'admin');

create or replace function public.sync_user_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_full_name text;
begin
  v_full_name := coalesce(new.raw_user_meta_data ->> 'full_name', '');

  if tg_op = 'INSERT' then
    insert into public.user_profiles (id, email, full_name)
    values (new.id, coalesce(new.email, ''), v_full_name)
    on conflict (id) do update
      set email = excluded.email,
          full_name = excluded.full_name,
          updated_at = now();
    return new;
  end if;

  update public.user_profiles
  set email = coalesce(new.email, ''),
      full_name = v_full_name,
      require_email_change = case
        when old.email is distinct from new.email then false
        else require_email_change
      end,
      require_name_change = case
        when coalesce(old.raw_user_meta_data ->> 'full_name', '')
          is distinct from v_full_name then false
        else require_name_change
      end,
      require_password_change = case
        when old.encrypted_password is distinct from new.encrypted_password then false
        else require_password_change
      end,
      updated_at = now()
  where id = new.id;

  if not found then
    insert into public.user_profiles (id, email, full_name)
    values (new.id, coalesce(new.email, ''), v_full_name);
  end if;

  return new;
end;
$$;

revoke all on function public.sync_user_profile() from public, anon, authenticated;

drop trigger if exists sync_user_profile on auth.users;
create trigger sync_user_profile
after insert or update
on auth.users
for each row
execute function public.sync_user_profile();

insert into public.user_profiles (id, email, full_name)
select id, coalesce(email, ''), coalesce(raw_user_meta_data ->> 'full_name', '')
from auth.users
on conflict (id) do update
set email = excluded.email,
    full_name = excluded.full_name,
    updated_at = now();
