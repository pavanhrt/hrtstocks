"use client";

import { useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { signIn, signUp, requestPasswordReset, type ActionState } from "./actions";

const initialState: ActionState = { error: null, notice: null };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} style={{ width: "100%", padding: "10px 0" }}>
      {pending ? "Working..." : label}
    </button>
  );
}

export default function LoginForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "reset">("sign-in");
  const [signInState, signInAction] = useFormState(signIn, initialState);
  const [signUpState, signUpAction] = useFormState(signUp, initialState);
  const [resetState, resetAction] = useFormState(requestPasswordReset, initialState);

  const active = mode === "sign-in" ? signInState : mode === "sign-up" ? signUpState : resetState;

  return (
    <div className="card" style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1 style={{ fontSize: 18, marginTop: 0 }}>Stock Research Workspace</h1>

      {mode === "sign-in" && (
        <form action={signInAction} style={{ display: "grid", gap: 10 }}>
          <input type="hidden" name="next" value={next} />
          <input name="email" type="email" placeholder="Email" required autoComplete="email" />
          <input
            name="password"
            type="password"
            placeholder="Password"
            required
            autoComplete="current-password"
          />
          <SubmitButton label="Sign in" />
        </form>
      )}

      {mode === "sign-up" && (
        <form action={signUpAction} style={{ display: "grid", gap: 10 }}>
          <input name="email" type="email" placeholder="Email" required autoComplete="email" />
          <input
            name="password"
            type="password"
            placeholder="Password (min 6 characters)"
            required
            minLength={6}
            autoComplete="new-password"
          />
          <SubmitButton label="Create account" />
        </form>
      )}

      {mode === "reset" && (
        <form action={resetAction} style={{ display: "grid", gap: 10 }}>
          <input name="email" type="email" placeholder="Email" required autoComplete="email" />
          <SubmitButton label="Send reset link" />
        </form>
      )}

      {active.error && (
        <p style={{ color: "var(--fail)", fontSize: 13, marginBottom: 0 }}>{active.error}</p>
      )}
      {active.notice && (
        <p style={{ color: "var(--pass)", fontSize: 13, marginBottom: 0 }}>{active.notice}</p>
      )}

      <div style={{ marginTop: 16, fontSize: 13, color: "var(--text-dim)", display: "flex", gap: 12 }}>
        {mode !== "sign-in" && (
          <button type="button" onClick={() => setMode("sign-in")} style={{ background: "none", border: "none", color: "var(--accent)", padding: 0 }}>
            Sign in
          </button>
        )}
        {mode !== "sign-up" && (
          <button type="button" onClick={() => setMode("sign-up")} style={{ background: "none", border: "none", color: "var(--accent)", padding: 0 }}>
            Create account
          </button>
        )}
        {mode !== "reset" && (
          <button type="button" onClick={() => setMode("reset")} style={{ background: "none", border: "none", color: "var(--accent)", padding: 0 }}>
            Forgot password?
          </button>
        )}
      </div>

      <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-dim)" }}>
        New accounts default to the Viewer role. Ask a system administrator to grant Researcher or
        higher access.
      </p>
    </div>
  );
}
