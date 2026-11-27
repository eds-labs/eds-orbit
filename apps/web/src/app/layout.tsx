import type { Metadata } from "next";
import { appearanceBootstrap } from "@/platform/appearance/preference";
import "./globals.css";
export const metadata: Metadata = {
  title: "EDS Orbit",
  description:
    "A self-hosted, modular work platform. Trusted knowledge, accountable autonomy.",
  robots: { index: false, follow: false },
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta name="color-scheme" content="light dark" />
        <script>{appearanceBootstrap}</script>
      </head>
      <body>{children}</body>
    </html>
  );
}
