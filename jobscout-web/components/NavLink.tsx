"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/** A nav item that knows whether it is the page you are on. */
export function NavLink({ href, children }: { href: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);

  return (
    <Link
      href={href}
      aria-current={active ? "page" : undefined}
      className={
        active
          ? "rounded-lg bg-brand-soft px-3 py-1.5 text-sm font-semibold text-brand"
          : "rounded-lg px-3 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas hover:text-ink"
      }
    >
      {children}
    </Link>
  );
}
