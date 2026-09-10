import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import SignOutButton from "./SignOutButton";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const links = [
    { href: "/dashboard", label: "Dashboard" },
    { href: "/buy-signals", label: "Buy signals" },
    { href: "/sell-signals", label: "Sell signals" },
    { href: "/analysis", label: "Analysis" },
    { href: "/direction", label: "Direction" },
    { href: "/indexes", label: "Indexes" },
    { href: "/stocks", label: "Stock ledger" },
    { href: "/news", label: "News" },
    { href: "/strategies", label: "Strategies" },
    { href: "/backtests", label: "Backtests" },
    { href: "/data-health", label: "Data health" },
  ];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header
        style={{
          borderBottom: "1px solid var(--panel-border)",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <nav style={{ display: "flex", gap: 18, alignItems: "center" }}>
          <strong style={{ marginRight: 8 }}>Stock Research</strong>
          {links.map((l) => (
            <Link key={l.href} href={l.href} style={{ color: "var(--text)", fontSize: 14 }}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 13, color: "var(--text-dim)" }}>
          <span>
            {user.email} &middot; <span style={{ textTransform: "capitalize" }}>{user.role.replace("_", " ")}</span>
          </span>
          <SignOutButton />
        </div>
      </header>
      <main style={{ padding: 20, flex: 1 }}>{children}</main>
    </div>
  );
}
