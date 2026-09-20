import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Get Secure CRM", template: "%s · Get Secure CRM" },
  description: "Leads, quotes, jobs and scheduling for Get Secure.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
