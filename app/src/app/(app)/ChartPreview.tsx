"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";

export default function ChartPreview({
  src,
  alt,
  compact = false,
}: {
  src: string | null;
  alt: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus();
  }, [open]);

  if (!src) {
    return <div className={compact ? "chart-placeholder compact" : "chart-placeholder"} role="status">Chart unavailable</div>;
  }

  return (
    <>
      <button type="button" className="chart-preview-button" onClick={() => setOpen(true)} aria-label={`Enlarge ${alt}`}>
        <Image className={compact ? "chart-thumbnail compact" : "chart-thumbnail"} src={src} alt={alt} width={compact ? 150 : 320} height={compact ? 75 : 160} loading="lazy" unoptimized />
        <span>Enlarge chart</span>
      </button>
      {open && (
        <div className="chart-modal" role="dialog" aria-modal="true" aria-label={alt} onKeyDown={(event) => event.key === "Escape" && setOpen(false)}>
          <div className="chart-modal-panel">
            <button ref={closeButtonRef} type="button" className="chart-modal-close" onClick={() => setOpen(false)}>
              Close
            </button>
            <Image src={src} alt={alt} width={1200} height={600} unoptimized />
          </div>
        </div>
      )}
    </>
  );
}
