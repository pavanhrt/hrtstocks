// Automatic Next.js App Router convention: wraps every page under (app)/ in
// a Suspense boundary at this level, so the nav/header from (app)/layout.tsx
// stays stable and only this fallback replaces the <main> content area while
// a page's Server Component data fetch is in flight. Previously there was no
// loading.tsx anywhere in the app at all -- every navigation showed a blank
// page until the fetch resolved.
export default function AppLoading() {
  return (
    <div className="card" role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", gap: 12 }}>
      <span className="spinner" aria-hidden="true" />
      <span style={{ color: "var(--text-dim)", fontSize: 14 }}>Loading…</span>
    </div>
  );
}
