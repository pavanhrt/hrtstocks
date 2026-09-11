import Link from "next/link";

// Root-level Next.js App Router convention -- previously nonexistent, so a
// mistyped or stale URL fell through to Next's default unstyled 404 page.
export default function NotFound() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div className="card" style={{ maxWidth: 420, width: "100%" }}>
        <h1 style={{ marginTop: 0, fontSize: 18 }}>Page not found</h1>
        <p style={{ color: "var(--text-dim)", fontSize: 13 }}>The page you&apos;re looking for doesn&apos;t exist.</p>
        <Link href="/dashboard">Back to Dashboard</Link>
      </div>
    </div>
  );
}
