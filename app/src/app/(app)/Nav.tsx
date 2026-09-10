"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

export type NavLink = { href: string; label: string };

/**
 * Problem #29 (architecture-plan.md baseline audit): the nav was a flat,
 * unresponsive row of plain <Link>s -- no active-state styling (a user had
 * no way to tell which page they were on from the nav itself) and no
 * responsive collapse (on a narrow viewport the row just overflows). Needs
 * usePathname for the active link, so this is a client component; the
 * surrounding layout (auth check, role display, sign-out) stays server-side
 * in layout.tsx.
 */
export default function Nav({ links }: { links: NavLink[] }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <nav aria-label="Primary" style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <strong style={{ marginRight: 8 }}>Stock Research</strong>
      <button
        type="button"
        className="nav-toggle"
        aria-expanded={open}
        aria-controls="primary-nav-links"
        onClick={() => setOpen((o) => !o)}
      >
        Menu
      </button>
      <div id="primary-nav-links" className={open ? "nav-links open" : "nav-links"}>
        {links.map((l) => {
          const active = l.href === "/dashboard" ? pathname === l.href : pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <Link
              key={l.href}
              href={l.href}
              className="nav-link"
              aria-current={active ? "page" : undefined}
              onClick={() => setOpen(false)}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
