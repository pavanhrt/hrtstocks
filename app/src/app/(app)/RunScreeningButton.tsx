"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function RunScreeningButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function trigger() {
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/screening-runs", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start run");
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <button onClick={trigger} disabled={pending}>
        {pending ? "Starting run..." : "Run screening now"}
      </button>
      {error && <p style={{ color: "var(--fail)", fontSize: 13 }}>{error}</p>}
    </div>
  );
}
