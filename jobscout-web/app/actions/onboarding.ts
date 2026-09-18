"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { profiles, users } from "@/lib/db/schema";
import { parseList } from "@/lib/preferences";
import { readCv, ScoutError } from "@/lib/scout";

export type UploadState = { status: "idle" | "error"; message: string };
export type PreferencesState = { status: "idle" | "error"; message: string };

const ACCEPTED = [".pdf", ".docx", ".txt", ".md"];

export async function uploadCv(_previous: UploadState, formData: FormData): Promise<UploadState> {
  const user = await requireUser({ allowUnonboarded: true });
  const file = formData.get("cv");

  if (!(file instanceof File) || file.size === 0) {
    return { status: "error", message: "Choose a CV file first." };
  }
  if (!ACCEPTED.some((extension) => file.name.toLowerCase().endsWith(extension))) {
    return {
      status: "error",
      message: `That file type is not supported. Use one of: ${ACCEPTED.join(", ")}`,
    };
  }

  // Read the bytes ONCE, before anything else touches the upload. readCv
  // streams the File out through fetch/FormData, which consumes it -- asking
  // the same File for its bytes afterwards can hand back nothing, and the
  // stored CV silently becomes empty. Everything below works from `bytes`.
  const bytes = Buffer.from(await file.arrayBuffer());

  let profile;
  try {
    profile = await readCv(new File([bytes], file.name, { type: file.type }));
  } catch (error) {
    if (error instanceof ScoutError) {
      return { status: "error", message: error.message };
    }
    console.error("CV read failed", error);
    return { status: "error", message: "The CV could not be read. Try a different export." };
  }

  // Only a PDF is kept: tailoring edits the original file in place, and
  // there is no in-place edit to make to a .docx or .txt. Stored as base64
  // so it travels through the same JSON path as everything else.
  const isPdf = file.name.toLowerCase().endsWith(".pdf");
  const cvFile = isPdf && bytes.length > 0 ? bytes.toString("base64") : null;

  const db = await getDb();
  const row = {
    cvFilename: file.name,
    cvText: profile.cv_text,
    cvFile,
    name: profile.name,
    headline: profile.headline,
    seniority: profile.seniority,
    yearsExperience: profile.years_experience,
    coreSkills: profile.core_skills,
    tools: profile.tools,
    domains: profile.domains,
    strengths: profile.strengths,
    gaps: profile.gaps,
    suggestedRoles: profile.search_queries,
    updatedAt: new Date(),
  };

  await db
    .insert(profiles)
    .values({
      userId: user.id,
      ...row,
      // Seed the editable targets from the CV's own suggestions. The next
      // screen lets them be changed; re-uploading a CV later must not silently
      // overwrite roles the user has since chosen for themselves.
      targetRoles: profile.search_queries,
    })
    .onConflictDoUpdate({ target: profiles.userId, set: row });

  redirect("/onboarding/preferences");
}

export async function savePreferences(
  _previous: PreferencesState,
  formData: FormData,
): Promise<PreferencesState> {
  const user = await requireUser({ allowUnonboarded: true });

  const targetRoles = parseList(formData.get("targetRoles"));
  if (targetRoles.length === 0) {
    return { status: "error", message: "Add at least one role to search for." };
  }

  const db = await getDb();
  await db
    .update(profiles)
    .set({
      targetRoles,
      cities: parseList(formData.get("cities")),
      remoteOnly: formData.get("remoteOnly") === "on",
      visaStatus: String(formData.get("visaStatus") ?? "unsure"),
      visaNote: String(formData.get("visaNote") ?? "").trim().slice(0, 300),
      updatedAt: new Date(),
    })
    .where(eq(profiles.userId, user.id));

  if (!user.onboardedAt) {
    await db.update(users).set({ onboardedAt: new Date() }).where(eq(users.id, user.id));
  }

  revalidatePath("/feed");
  redirect("/feed");
}
