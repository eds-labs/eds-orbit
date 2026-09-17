import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "EDS Orbit",
  description:
    "A self-hosted marketing workspace. Trusted knowledge, accountable autonomy.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
