import Link from "next/link";

import { requireAdmin } from "@/lib/auth/admin";

/**
 * The gate for everything under /admin.
 *
 * A layout rather than middleware, on purpose. Middleware runs on the edge
 * runtime, where this app's database driver does not, so the check would
 * have to be made against something weaker than the real session. Here it
 * runs on the server with the same session lookup as every other page, and
 * it covers every route in this segment -- a new admin page cannot ship
 * without the check, because it cannot render outside this layout.
 *
 * Route handlers under /admin do NOT pass through layouts, so each one calls
 * requireAdmin() itself.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireAdmin();

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header className="flex flex-wrap items-baseline justify-between gap-4 border-b border-line pb-4">
        <div className="flex items-baseline gap-4">
          <Link href="/admin" className="text-lg font-bold tracking-tight">
            Admin
          </Link>
          <Link href="/admin/user" className="text-sm text-ink-soft hover:underline">
            Look up a user
          </Link>
        </div>
        <div className="flex items-baseline gap-4">
          <span className="hint">{admin.email}</span>
          <Link href="/feed" className="text-sm text-ink-soft hover:underline">
            Back to the app
          </Link>
        </div>
      </header>

      {children}
    </div>
  );
}
