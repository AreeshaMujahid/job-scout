"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { and, asc, eq } from "drizzle-orm";

import { requireUser } from "@/lib/auth/session";
import { getDb } from "@/lib/db";
import { chatMessages, jobs } from "@/lib/db/schema";
import {
  applicationChat,
  ScoutError,
  toScoutProfile,
  type ApplicationChatTurn,
  type ScoutJob,
} from "@/lib/scout";

/**
 * The application-questions thread for one job.
 *
 * The transcript lives here rather than in the browser, because getting one
 * of these answers right takes several rounds and losing them to a refresh --
 * mid-application, with the form open in another tab -- is the failure that
 * would stop anyone using this.
 */

export type ChatState =
  | { status: "idle" }
  | { status: "error"; message: string };

/** How long a thread may get before it is the prompt rather than the question. */
const MAX_TURNS = 40;

export async function loadThread(jobId: string) {
  const user = await requireUser();
  const db = await getDb();
  return db
    .select()
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, user.id), eq(chatMessages.jobId, jobId)))
    .orderBy(asc(chatMessages.createdAt));
}

/**
 * Send one message and store both halves of the exchange.
 *
 * The user's message is written before the model is called, so a failed or
 * slow draft does not lose what they typed -- they can retry against a thread
 * that still has their question in it.
 */
export async function sendMessage(jobId: string, message: string): Promise<ChatState> {
  const user = await requireUser();
  const text = message.trim();
  if (!text) return { status: "idle" };

  if (!user.profile?.cvText) {
    return {
      status: "error",
      message: "Upload a CV first — the answers are drawn from it.",
    };
  }

  const db = await getDb();
  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) return { status: "error", message: "That job is not in your feed." };

  const history = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, user.id), eq(chatMessages.jobId, jobId)))
    .orderBy(asc(chatMessages.createdAt));

  if (history.length >= MAX_TURNS) {
    return {
      status: "error",
      message: "This thread is long enough to be confusing the answers. Clear it and start again.",
    };
  }

  await db.insert(chatMessages).values({
    id: randomUUID(),
    userId: user.id,
    jobId,
    role: "user",
    content: text.slice(0, 4000),
  });
  revalidatePath(`/jobs/${jobId}`);

  return draftReply(user.id, jobId, [...history, { role: "user", content: text }]);
}

/**
 * Answer the question already sitting at the end of the thread.
 *
 * For a turn that never came back: the model was rate-limited past its
 * retries, the request timed out, the server restarted, the tab was closed.
 * The question is stored before the model is called precisely so that this
 * is possible -- without it, a failed turn loses what the user typed and
 * they have to reconstruct it.
 */
export async function retryLast(jobId: string): Promise<ChatState> {
  const user = await requireUser();
  const db = await getDb();

  const history = await db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(eq(chatMessages.userId, user.id), eq(chatMessages.jobId, jobId)))
    .orderBy(asc(chatMessages.createdAt));

  const last = history[history.length - 1];
  if (!last || last.role !== "user") {
    // Nothing is waiting -- the answer arrived while they were deciding.
    return { status: "idle" };
  }

  return draftReply(user.id, jobId, history);
}

/**
 * Call the model for a transcript whose last turn is the user's, and store
 * the reply. Shared by a new message and a retry so the two cannot drift.
 */
async function draftReply(
  userId: string,
  jobId: string,
  history: { role: "user" | "assistant"; content: string }[],
): Promise<ChatState> {
  const user = await requireUser();
  const db = await getDb();

  const [row] = await db.select().from(jobs).where(eq(jobs.id, jobId)).limit(1);
  if (!row) return { status: "error", message: "That job is not in your feed." };
  if (!user.profile?.cvText) {
    return { status: "error", message: "Upload a CV first — the answers are drawn from it." };
  }

  const scoutJob: ScoutJob = {
    key: row.id,
    source: row.source,
    title: row.title,
    company: row.company,
    url: row.url,
    location: row.location,
    description: row.description,
    tags: row.tags,
    salary: row.salary,
    posted_at: row.postedAt,
    company_url: row.companyUrl,
    remote: row.remote,
    relevance: 0,
  };

  let result;
  try {
    result = await applicationChat({
      profile: toScoutProfile(user.profile),
      cvText: user.profile.cvText,
      history: history as ApplicationChatTurn[],
      job: scoutJob,
    });
  } catch (error) {
    const message =
      error instanceof ScoutError ? error.message : "Could not draft an answer.";
    return { status: "error", message };
  }

  if (result.error || !result.reply.trim()) {
    return { status: "error", message: result.error || "The model returned nothing. Try again." };
  }

  await db.insert(chatMessages).values({
    id: randomUUID(),
    userId,
    jobId,
    role: "assistant",
    content: result.reply,
    unsupported: result.unsupported ?? [],
  });

  revalidatePath(`/jobs/${jobId}`);
  return { status: "idle" };
}

/** Start again. The thread is the model's context, so clearing it is a real reset. */
export async function clearThread(jobId: string): Promise<void> {
  const user = await requireUser();
  const db = await getDb();
  await db
    .delete(chatMessages)
    .where(and(eq(chatMessages.userId, user.id), eq(chatMessages.jobId, jobId)));
  revalidatePath(`/jobs/${jobId}`);
}
