import Link from "next/link";
import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth/session";
import { FindForm } from "./FindForm";

export default async function FindPage() {
  const user = await requireUser();
  if (!user.profile) redirect("/onboarding");

  return (
    <div>
      <h1 className="text-3xl font-bold tracking-tight">Find jobs</h1>
      <p className="hint mt-2 max-w-3xl">
        Each title is searched once per location, and everything new is scored against your CV.
        Results appear below and in{" "}
        <Link href="/feed" className="font-medium text-brand hover:underline">
          your feed
        </Link>
        . Nothing is scored twice, and nothing is lost between runs.
      </p>

      <FindForm profile={user.profile} />
    </div>
  );
}
