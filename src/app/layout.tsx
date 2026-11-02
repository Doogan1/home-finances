import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home Finances",
  description: "Household accounts and balances",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
