import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BetPilot AI",
  description:
    "AI-ассистент для приёма и обработки спортивных ставок через WhatsApp: распознавание заявок, сверка коэффициентов, учёт баланса в USDC.",
};

export const viewport: Viewport = {
  themeColor: "#0B1F17",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <link
        rel="stylesheet"
        href="https://cdn.jsdelivr.net/npm/@tabler/icons-webfont@3.44.0/dist/tabler-icons.min.css"
        precedence="default"
      />

      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
