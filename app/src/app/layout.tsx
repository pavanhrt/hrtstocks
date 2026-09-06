import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stock Research Workspace",
  description: "Evidence-based NSE index and stock research: SMM, PAPA, GUE, and FOME rule screening.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
