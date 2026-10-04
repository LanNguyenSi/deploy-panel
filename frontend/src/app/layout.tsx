import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import "./fonts-extra.css";
import AppShell from "@/components/AppShell";
import { Providers } from "@/components/Providers";

const sora = localFont({
  src: [
    { path: "../fonts/sora-latin-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/sora-latin-wght-normal.woff2", weight: "700", style: "normal" },
  ],
  display: "swap",
  variable: "--font-display",
});

const inter = localFont({
  src: [
    { path: "../fonts/inter-latin-wght-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/inter-latin-wght-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/inter-latin-wght-normal.woff2", weight: "600", style: "normal" },
  ],
  display: "swap",
  variable: "--font-sans",
});

const jetbrainsMono = localFont({
  src: [
    { path: "../fonts/jetbrains-mono-latin-wght-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/jetbrains-mono-latin-wght-normal.woff2", weight: "500", style: "normal" },
  ],
  display: "swap",
  variable: "--font-mono",
});

export const metadata: Metadata = {
  title: "Deploy Panel",
  description: "VPS deployment management",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sora.variable} ${inter.variable} ${jetbrainsMono.variable}`}>
      <body>
        <Providers>
          <AppShell>
            {children}
          </AppShell>
        </Providers>
      </body>
    </html>
  );
}
