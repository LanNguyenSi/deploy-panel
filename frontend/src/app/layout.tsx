import type { Metadata } from "next";
import "./globals.css";
import Sidebar from "@/components/Sidebar";
import { Providers } from "@/components/Providers";

export const metadata: Metadata = {
  title: "Deploy Panel",
  description: "VPS deployment management",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <div className="app-layout">
            <Sidebar />
            <div className="app-content">
              {children}
            </div>
          </div>
        </Providers>
      </body>
    </html>
  );
}
