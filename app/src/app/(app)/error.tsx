"use client";

// Next.js App Router convention: catches a thrown error from any page under
// (app)/ (e.g. a failed Supabase query) at the same level loading.tsx sits,
// so the nav/header stays stable and only the <main> content area shows this
// instead of Next's default unstyled error screen -- previously there was no
// error.tsx anywhere in the app, so any thrown error fell through to that
// default screen with no way back into the app short of a manual URL change.
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="card" role="alert" aria-live="assertive">
      <h1 style={{ marginTop: 0, fontSize: 18 }}>Something went wrong</h1>
      <p style={{ color: "var(--text-dim)", fontSize: 13 }}>{error.message || "An unexpected error occurred while loading this page."}</p>
      <button onClick={() => reset()} style={{ background: "var(--accent)", color: "#fff", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 14 }}>
        Try again
      </button>
    </div>
  );
}
