"use client";

// Root-level counterpart to (app)/error.tsx -- catches a thrown error on any
// page OUTSIDE the (app) route group (login, auth/callback, auth/reset-password),
// which has no shared nav/header to keep stable, so this renders standalone
// rather than reusing (app)/error.tsx's layout assumptions.
export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="card" role="alert" aria-live="assertive" style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Something went wrong</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>{error.message || "An unexpected error occurred."}</p>
        <button onClick={() => reset()} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 14 }}>
          Try again
        </button>
      </div>
    </div>
  );
}
