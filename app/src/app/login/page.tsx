import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import { safeRedirectPath } from "@/lib/safe-redirect";
import LoginForm from "./LoginForm";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;
  // Already signed in (verified server-side)? Skip the form.
  if (await getCurrentUser()) redirect(safeRedirectPath(next));
  return <LoginForm next={safeRedirectPath(next)} />;
}
