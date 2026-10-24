import "./globals.css";
import type { Metadata } from "next";
import { AppearanceBar, ThemeProvider } from "@/components/theme/ThemeProvider";
import { themeBootstrap } from "@/components/theme/theme-runtime";

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
    <html lang="en" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeBootstrap }} /></head>
      <body className="antialiased">
        <ThemeProvider><AppearanceBar />{children}</ThemeProvider>
      </body>
    </html>
  );
}

