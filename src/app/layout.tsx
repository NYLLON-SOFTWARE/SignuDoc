import type { Metadata } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";

import { TooltipProvider } from "@/components/ui/tooltip";

import "./globals.css";

const archivo = Archivo({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-ui",
  weight: ["400", "500", "600", "700", "800", "900"],
});

const ibmPlexMono = IBM_Plex_Mono({
  display: "swap",
  subsets: ["latin"],
  variable: "--font-mono",
  weight: ["400", "500", "600", "700"],
});

export const metadata: Metadata = {
  title: "SignuDoc",
  description:
    "Free e-signature software for small businesses. Upload, send, sign — no enterprise circus required.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${archivo.variable} ${ibmPlexMono.variable} antialiased`}
      >
        <TooltipProvider>{children}</TooltipProvider>
      </body>
    </html>
  );
}
