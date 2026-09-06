-- bootstrap_admin_emails should never be readable/writable via the client API --
-- only the security-definer handle_new_user() trigger (which runs as the table
-- owner and bypasses RLS) needs it. Enabling RLS with zero policies blocks all
-- anon/authenticated access while leaving the trigger path intact.
alter table bootstrap_admin_emails enable row level security;

-- handle_new_user() is trigger-only: it references the trigger's NEW row and
-- has no legitimate direct caller, so remove it from the PostgREST RPC surface.
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- current_role_name() only ever returns the caller's own role (looked up via
-- auth.uid()), so it's safe for signed-in users, but there's no reason for an
-- unauthenticated caller to probe it.
revoke execute on function public.current_role_name() from public, anon;
grant execute on function public.current_role_name() to authenticated;
