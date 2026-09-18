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
    { href: "/buy-setup-analysis", label: "Buy setup analysis" },
    { href: "/fome", label: "FOME" },
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
    <div className="app-shell">
      <header className="app-header">
        <Nav links={links} />
        <div className="app-header-user">
          <span>
            {user.email} &middot; <span style={{ textTransform: "capitalize" }}>{user.role.replace("_", " ")}</span>
          </span>
          <SignOutButton />
        </div>
      </header>
      <main className="app-main">{children}</main>
    </div>
  );
}
