"use client";

import { useState, type CSSProperties, type FormEvent, type InputHTMLAttributes } from "react";
import { useRouter } from "next/navigation";
import {
  createUserWithEmailAndPassword,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from "firebase/auth";
import { clientAuth } from "@/lib/firebase/client";
import { safeRedirectPath } from "@/lib/safe-redirect";

type Status = { error: string | null; notice: string | null };
const idle: Status = { error: null, notice: null };

const labelStyle: CSSProperties = { fontSize: 12, color: "var(--text-dim)", display: "block", marginBottom: 2 };

function Field({ id, label, ...inputProps }: { id: string; label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <input id={id} {...inputProps} style={{ width: "100%" }} />
    </div>
  );
}

// Open self-signup is off by default (invite-only). The server enforces this
// regardless of what the browser shows; this flag only hides the tab.
const SIGNUP_ENABLED = process.env.NEXT_PUBLIC_SIGNUP_MODE === "open";

async function exchangeForSession(idToken: string): Promise<Status> {
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
  });
  if (res.ok) return idle;
  if (res.status === 403) {
    return { error: "This account is not authorized for access. Ask an administrator for an invitation.", notice: null };
  }
  return { error: "Sign-in failed. Please try again.", notice: null };
}

export default function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<"sign-in" | "sign-up" | "reset">("sign-in");
  const [status, setStatus] = useState<Status>(idle);
  const [pending, setPending] = useState(false);

  async function run(work: () => Promise<Status>) {
    setPending(true);
    setStatus(idle);
    try {
      setStatus(await work());
    } catch {
      // Generic on purpose: do not reveal whether an account exists.
      setStatus({ error: "Could not complete the request. Check your details and try again.", notice: null });
    } finally {
      setPending(false);
    }
  }

  function onSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const auth = clientAuth();
      const credential = await signInWithEmailAndPassword(auth, String(form.get("email")), String(form.get("password")));
      const result = await exchangeForSession(await credential.user.getIdToken());
      await signOut(auth); // the httpOnly server session cookie is authoritative from here on
      if (!result.error) {
        router.replace(safeRedirectPath(next));
        router.refresh();
      }
      return result;
    });
  }

  function onSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      const auth = clientAuth();
      const credential = await createUserWithEmailAndPassword(auth, String(form.get("email")), String(form.get("password")));
      await sendEmailVerification(credential.user);
      await signOut(auth);
      return { error: null, notice: "Account created. Check your email to verify it, then sign in." };
    });
  }

  function onReset(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    void run(async () => {
      try {
        await sendPasswordResetEmail(clientAuth(), String(form.get("email")));
      } catch {
        // Same message whether or not the address exists.
      }
      return { error: null, notice: "If that email has an account, a reset link was sent." };
    });
  }

  const linkStyle: CSSProperties = { background: "none", border: "none", color: "var(--accent)", padding: 0 };

  return (
    <div className="card" style={{ maxWidth: 360, margin: "80px auto" }}>
      <h1 style={{ fontSize: 18, marginTop: 0 }}>Stock Research Workspace</h1>

      {mode === "sign-in" && (
        <form onSubmit={onSignIn} style={{ display: "grid", gap: 10 }}>
          <Field id="signin-email" label="Email" name="email" type="email" placeholder="you@example.com" required autoComplete="email" />
          <Field id="signin-password" label="Password" name="password" type="password" placeholder="********" required autoComplete="current-password" />
          <button type="submit" disabled={pending} style={{ width: "100%", padding: "10px 0" }}>
            {pending ? "Working..." : "Sign in"}
          </button>
        </form>
      )}

      {mode === "sign-up" && SIGNUP_ENABLED && (
        <form onSubmit={onSignUp} style={{ display: "grid", gap: 10 }}>
          <Field id="signup-email" label="Email" name="email" type="email" placeholder="you@example.com" required autoComplete="email" />
          <Field id="signup-password" label="Password (min 8 characters)" name="password" type="password" placeholder="********" required minLength={8} autoComplete="new-password" />
          <button type="submit" disabled={pending} style={{ width: "100%", padding: "10px 0" }}>
            {pending ? "Working..." : "Create account"}
          </button>
        </form>
      )}

      {mode === "reset" && (
        <form onSubmit={onReset} style={{ display: "grid", gap: 10 }}>
          <Field id="reset-email" label="Email" name="email" type="email" placeholder="you@example.com" required autoComplete="email" />
          <button type="submit" disabled={pending} style={{ width: "100%", padding: "10px 0" }}>
            {pending ? "Working..." : "Send reset link"}
          </button>
        </form>
      )}

      <div role="status" aria-live="polite">
        {status.error && <p style={{ color: "var(--fail)", fontSize: 13, marginBottom: 0 }}>{status.error}</p>}
        {status.notice && <p style={{ color: "var(--pass)", fontSize: 13, marginBottom: 0 }}>{status.notice}</p>}
      </div>

      <div style={{ marginTop: 16, fontSize: 13, color: "var(--text-dim)", display: "flex", gap: 12 }}>
        {mode !== "sign-in" && (
          <button type="button" onClick={() => setMode("sign-in")} style={linkStyle}>
            Sign in
          </button>
        )}
        {SIGNUP_ENABLED && mode !== "sign-up" && (
          <button type="button" onClick={() => setMode("sign-up")} style={linkStyle}>
            Create account
          </button>
        )}
        {mode !== "reset" && (
          <button type="button" onClick={() => setMode("reset")} style={linkStyle}>
            Forgot password?
          </button>
        )}
      </div>

      <p style={{ marginTop: 16, fontSize: 12, color: "var(--text-dim)" }}>
        Access is by invitation. Ask a system administrator to invite you or to grant Researcher or higher access.
      </p>
    </div>
  );
}
