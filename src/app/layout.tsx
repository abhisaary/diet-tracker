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

const isDevelopment = process.env.NODE_ENV === "development";
const appIcon = isDevelopment ? "/dev-app-icon.png" : "/icon.png";
const appleTouchIcon = isDevelopment
  ? "/dev-apple-touch-icon.png"
  : "/apple-touch-icon.png";

export const metadata: Metadata = {
  applicationName: isDevelopment ? "Diet Tracker Dev" : "Diet Tracker",
  description: "Personal meal, macro, and gut symptom tracker.",
  icons: {
    apple: appleTouchIcon,
    icon: appIcon,
    shortcut: appIcon,
  },
  title: isDevelopment ? "Diet Tracker Dev" : "Diet Tracker",
};

export const viewport: Viewport = {
  initialScale: 1,
  viewportFit: "cover",
  width: "device-width",
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
      <body className="min-h-full overflow-x-hidden bg-slate-50">{children}</body>
    </html>
  );
}
