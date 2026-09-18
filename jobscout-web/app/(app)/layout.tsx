import Link from "next/link";

import { signOutAction } from "@/app/actions/auth";
import { requireUser } from "@/lib/auth/session";
import { NavLink } from "@/components/NavLink";

// Typed as plain children rather than LayoutProps<...>: this layout wraps a
// route group covering several paths, which the generated per-route type
// cannot express.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  // Signed in is all this shell requires. Whether onboarding must be finished
  // is each page's own call -- the feed insists on it, Settings deliberately
  // does not, so an abandoned signup can still be deleted.
  const user = await requireUser({ allowUnonboarded: true });

  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-4">
          <Link href="/feed" className="text-lg font-bold tracking-tight">
            Job Scout
          </Link>

          <nav className="flex items-center gap-1">
            <NavLink href="/find">Find jobs</NavLink>
            <NavLink href="/feed">Feed</NavLink>
            <NavLink href="/tracker">Tracker</NavLink>
            <NavLink href="/settings">Settings</NavLink>
          </nav>

          <div className="ml-auto flex items-center gap-4">
            <span className="hidden text-sm text-ink-faint sm:inline">{user.email}</span>
            <form action={signOutAction}>
              <button type="submit" className="text-sm font-medium text-ink-soft hover:underline">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-10">{children}</main>
    </div>
  );
}
