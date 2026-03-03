import "./globals.css";
import type { Metadata } from "next";
import { Space_Grotesk, Sora } from "next/font/google";

const display = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-display"
});

const body = Sora({
  subsets: ["latin"],
  variable: "--font-body"
});

export const metadata: Metadata = {
  title: "Circles Quests App",
  description:
    "In-app Circles quests with onchain execution and deterministic verification."
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
