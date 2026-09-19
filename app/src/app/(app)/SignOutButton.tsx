"use client";

import { useRouter } from "next/navigation";

export default function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        router.push("/login");
        router.refresh();
      }}
      style={{ background: "none", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, padding: "4px 10px" }}
    >
      Sign out
    </button>
  );
}
