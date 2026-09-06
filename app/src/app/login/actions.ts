"use server";

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { SITE_URL } from "@/lib/env";

export type ActionState = { error: string | null; notice: string | null };

export async function signIn(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "/dashboard");

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message, notice: null };

  redirect(next || "/dashboard");
}

export async function signUp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "");
  const password = String(formData.get("password") ?? "");

  const supabase = await createClient();
  const { error } = await supabase.auth.signUp({ email, password });
  if (error) return { error: error.message, notice: null };

  return {
    error: null,
    notice: "Account created. Check your email to confirm it, then sign in.",
  };
}

export async function requestPasswordReset(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const email = String(formData.get("email") ?? "");
  const supabase = await createClient();

  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${SITE_URL}/auth/callback?next=/auth/reset-password`,
  });
  if (error) return { error: error.message, notice: null };

  return { error: null, notice: "If that email has an account, a reset link was sent." };
}
