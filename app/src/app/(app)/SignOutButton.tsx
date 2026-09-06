"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function SignOutButton() {
  const router = useRouter();
  return (
    <button
      onClick={async () => {
        await createClient().auth.signOut();
        router.push("/login");
        router.refresh();
      }}
      style={{ background: "none", border: "1px solid var(--panel-border)", color: "var(--text)", borderRadius: 6, padding: "4px 10px" }}
    >
      Sign out
    </button>
  );
}
