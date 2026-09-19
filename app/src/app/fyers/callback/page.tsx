// FYERS OAuth redirect target for the manual daily token rotation (docs/gcp/runbooks/fyers-token.md).
// This page deliberately does nothing with the request: it never reads, logs, stores or forwards the
// query string. FYERS appends `?auth_code=...` to the URL; the operator copies the FULL address from the
// browser's address bar into `node scripts/fyers-get-token.mjs "<url>"`, then closes this tab.
// It is public (no session) because the operator is redirected here by FYERS; the auth_code is a
// short-lived, single-use value that is useless without the FYERS app secret.
export const metadata = { title: "FYERS redirect", robots: { index: false, follow: false } };

export default function FyersCallbackPage() {
  return (
    <div className="card" style={{ maxWidth: 520, margin: "80px auto" }}>
      <h1 style={{ fontSize: 18, marginTop: 0 }}>FYERS authorization received</h1>
      <p style={{ fontSize: 14 }}>
        Nothing on this page reads or stores the authorization code. Copy the <strong>full address</strong> from your browser&apos;s
        address bar (it contains <code>auth_code=...</code>) and paste it into the token script on your own machine, then close this tab.
      </p>
      <p style={{ fontSize: 13, color: "var(--text-dim)" }}>
        Steps: <code>docs/gcp/runbooks/fyers-token.md</code>
      </p>
    </div>
  );
}
