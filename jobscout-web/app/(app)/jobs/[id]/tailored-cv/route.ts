import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { jobs, ratings } from "@/lib/db/schema";
import { renderTailoredCvPdf, ScoutError } from "@/lib/scout";

/**
 * Download the user's own CV with this posting's wording swapped in.
 *
 * The file is built here rather than stored: the saved edits are applied to
 * the original PDF on each request, so the download always reflects the CV
 * currently on the account. A route handler rather than a server action for
 * the same reason as the cover-letter download -- a plain GET with
 * Content-Disposition triggers the browser's own "Save As" with no client
 * JavaScript, which an action's return value cannot do.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;

  // A failed download shows the user nothing but a broken file, so each way
  // this can refuse says so in the log as well as the body.
  if (!user.profile?.cvFile) {
    console.warn(`tailored-cv ${id}: no cvFile stored for user ${user.id}`);
    return NextResponse.json(
      { error: "No PDF CV is on file. Re-upload your CV as a PDF to use this." },
      { status: 404 },
    );
  }

  const db = await getDb();
  const [row] = await db
    .select({ job: jobs, rating: ratings })
    .from(jobs)
    .innerJoin(ratings, and(eq(ratings.jobId, jobs.id), eq(ratings.userId, user.id)))
    .where(eq(jobs.id, id))
    .limit(1);

  if (!row) {
    console.warn(`tailored-cv ${id}: no rated job for user ${user.id}`);
    return NextResponse.json({ error: "Job not found." }, { status: 404 });
  }
  if (!row.rating.tailoredCvEdits?.length) {
    console.warn(`tailored-cv ${id}: no saved edits on the rating`);
    return NextResponse.json(
      { error: "No CV tailoring has been generated for this job yet." },
      { status: 404 },
    );
  }

  let pdf;
  try {
    pdf = await renderTailoredCvPdf({
      cvBase64: user.profile.cvFile,
      edits: row.rating.tailoredCvEdits,
    });
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not build the PDF.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const stem = `${row.job.company}_${row.job.title}`
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);

  return new NextResponse(pdf.bytes, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="CV_${stem || "tailored"}.pdf"`,
      "Content-Length": String(pdf.bytes.byteLength),
    },
  });
}
