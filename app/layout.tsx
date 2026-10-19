import type { Metadata } from "next";
import "./globals.css";

// Fonts are chosen in T-16; next/font/google is avoided because it needs the network at build time.
export const metadata: Metadata = {
  title: "Neem & Ember",
  description: "Book a table and ask about Neem & Ember's branches, hours and menu.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
