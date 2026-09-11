"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function ResetPasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const supabase = createClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      return;
    }
    setDone(true);
    setTimeout(() => router.push("/dashboard"), 1200);
  }

  return (
    <div className="card" style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1 style={{ fontSize: 18, marginTop: 0 }}>Set a new password</h1>
      {done ? (
        <p role="status" aria-live="polite" style={{ color: "var(--pass)" }}>
          Password updated. Redirecting...
        </p>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: "grid", gap: 10 }}>
          <label htmlFor="new-password" style={{ fontSize: 13, color: "var(--text-dim)" }}>
            New password
          </label>
          <input
            id="new-password"
            type="password"
            placeholder="New password"
            required
            minLength={6}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
          <button type="submit">Update password</button>
          {error && (
            <p role="status" aria-live="polite" style={{ color: "var(--fail)", fontSize: 13 }}>
              {error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
