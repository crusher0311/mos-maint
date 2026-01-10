import "./globals.css";
import type { Metadata } from "next";

export const metadata: Metadata = { 
  title: "MOS Tools",
  description: "Automotive maintenance management system",
  icons: {
    icon: "/icon.png",
    apple: "/icon.png",
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}

