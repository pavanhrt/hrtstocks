-- Invite-only sign-in links a verified Identity Platform account to the
-- pre-provisioned profile by email, so an email must identify exactly one profile.
create unique index profiles_email_lower_key on profiles (lower(email));
