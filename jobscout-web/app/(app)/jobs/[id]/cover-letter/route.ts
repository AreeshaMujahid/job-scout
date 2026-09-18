import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobs, ratings } from "@/lib/db/schema";
import { renderCoverLetterPdf, ScoutError } from "@/lib/scout";

/**
 * Download the saved cover letter for one job as a PDF.
 *
 * A route handler rather than a server action: a server action's return
 * value goes through React's action mechanism, not a raw byte stream a
 * browser can be handed as a file, so there is no clean way to trigger a
 * "Save As" from one. A plain GET with Content-Disposition does exactly
 * that with a normal <a href> and no client-side JavaScript at all.
 *
 * Route handlers do not inherit the (app) layout's checks -- they do not
 * participate in layouts at all -- so requireUser() is called directly
 * here, the same as every server action does.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  const db = await getDb();
  const [row] = await db
    .select({ job: jobs, rating: ratings })
    .from(jobs)
    .innerJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .where(eq(jobs.id, id))
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  if (!row.rating.coverLetter.trim()) {
    return NextResponse.json(
      { error: "No cover letter has been generated for this job yet." },
      { status: 404 },
    );
  }

  let pdfBytes: ArrayBuffer;
  try {
    pdfBytes = await renderCoverLetterPdf({
      letter: row.rating.coverLetter,
      jobTitle: row.job.title,
      company: row.job.company,
      candidateName: user.profile?.name ?? "",
      candidateEmail: user.email,
    });
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not render the PDF.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const stem = `${row.job.company}_${row.job.title}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return new NextResponse(pdfBytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="Cover_Letter_${stem || "application"}.pdf"`,
      "Content-Length": String(pdfBytes.byteLength),
    },
  });
}
