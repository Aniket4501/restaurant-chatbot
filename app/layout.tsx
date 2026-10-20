import type { Metadata } from "next";
import "./globals.css";

// System font stacks only (app/globals.css): next/font/google would need the network at build time (§7.4).
export const metadata: Metadata = {
  title: "Neem & Ember",
  description: "Book a table and ask about Neem & Ember's branches, hours and menu.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="antialiased">
      <body>{children}</body>
    </html>
  );
}
