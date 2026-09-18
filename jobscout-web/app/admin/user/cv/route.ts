import { NextResponse, type NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";

import { logAdminAction, requireAdmin } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { jobs, profiles, ratings, users } from "@/lib/db/schema";
import { renderTailoredCvPdf, ScoutError } from "@/lib/scout";

/**
 * A user's CV, original or tailored, for checking that tailoring works.
 *
 * Route handlers do not pass through layouts, so the admin check is made here
 * rather than inherited -- `app/admin/layout.tsx` guards the pages and this
 * guards itself. Getting that wrong would leave every CV in the database
 * behind a URL anyone could guess.
 *
 * With `?job=` the saved edits for that posting are applied to the original
 * on the way out, exactly as the user's own download does, so the two files
 * can be opened side by side. Nothing tailored is stored anywhere.
 *
 * Every download writes an audit row naming the admin and the user.
 */
export async function GET(request: NextRequest) {
  const admin = await requireAdmin();

  const email = (request.nextUrl.searchParams.get("email") ?? "").trim().toLowerCase();
  const jobId = request.nextUrl.searchParams.get("job") ?? "";
  if (!email) return NextResponse.json({ error: "email is required" }, { status: 400 });

  const db = await getDb();
  const [row] = await db
    .select({ userId: users.id, cvFile: profiles.cvFile, cvFilename: profiles.cvFilename })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.email, email))
    .limit(1);

  if (!row?.cvFile) {
    return NextResponse.json(
      { error: "No PDF CV on file for that user." },
      { status: 404 },
    );
  }

  const stem = (row.cvFilename ?? "cv").replace(/\.pdf$/i, "").replace(/[^A-Za-z0-9]+/g, "_");

  // The original, untouched.
  if (!jobId) {
    await logAdminAction(admin.email, "downloaded CV", email, row.cvFilename ?? "");
    return pdfResponse(Buffer.from(row.cvFile, "base64"), `${stem}_original.pdf`);
  }

  const [job] = await db
    .select({ title: jobs.title, company: jobs.company, edits: ratings.tailoredCvEdits })
    .from(ratings)
    .innerJoin(jobs, eq(jobs.id, ratings.jobId))
    .where(and(eq(ratings.userId, row.userId), eq(ratings.jobId, jobId)))
    .limit(1);

  if (!job) return NextResponse.json({ error: "No such rated job." }, { status: 404 });
  if (!job.edits.length) {
    return NextResponse.json(
      { error: "No CV tailoring has been generated for that job." },
      { status: 404 },
    );
  }

  let pdf;
  try {
    pdf = await renderTailoredCvPdf({ cvBase64: row.cvFile, edits: job.edits });
  } catch (error) {
    const message = error instanceof ScoutError ? error.message : "Could not build the PDF.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  await logAdminAction(
    admin.email,
    "downloaded tailored CV",
    email,
    `${job.company} — ${job.title}`,
  );

  const suffix = `${job.company}_${job.title}`.replace(/[^A-Za-z0-9]+/g, "_").slice(0, 60);
  return pdfResponse(Buffer.from(pdf.bytes), `${stem}_${suffix}.pdf`, {
    // Surfaced as headers so the result can be read without opening the file:
    // how many edits went on, how many were refused, and how many needed a
    // new line. That is the whole question this page exists to answer.
    "X-CV-Edits-Applied": String(pdf.applied),
    "X-CV-Edits-Skipped": String(pdf.skipped),
  });
}

function pdfResponse(bytes: Buffer, filename: string, extra: Record<string, string> = {}) {
  return new NextResponse(new Uint8Array(bytes), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(bytes.byteLength),
      ...extra,
    },
  });
}
