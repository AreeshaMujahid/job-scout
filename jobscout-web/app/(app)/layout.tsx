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
        {/* flex-wrap, because the row could not fit a phone: four nav links,
            a wordmark and a sign-out button came to 408px inside 375, and the
            whole page scrolled sideways as a result. Wrapping costs a second
            line on a narrow screen and nothing at all on a wide one. */}
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-4">
          <Link href="/feed" className="text-lg font-bold tracking-tight">
            Job Scout
          </Link>

          <nav className="flex flex-wrap items-center gap-1">
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
