import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth";
import SignOutButton from "./SignOutButton";
import Nav from "./Nav";

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
          position: "relative",
          borderBottom: "1px solid var(--panel-border)",
          padding: "10px 20px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Nav links={links} />
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
