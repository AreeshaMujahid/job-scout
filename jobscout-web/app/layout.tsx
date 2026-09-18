import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Job Scout",
  description:
    "Upload your CV. Get jobs from six boards, scored, with the reasons you would want before spending an evening on an application.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
