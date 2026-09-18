"use client";

import { useOptimistic, useRef, useState, useTransition } from "react";

import { clearThread, retryLast, sendMessage } from "@/app/actions/applicationChat";

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  unsupported: string[];
};

/**
 * The application questions panel.
 *
 * For the boxes on an application form that a CV upload does not answer --
 * "a model you trained and how you measured success", "what are you proudest
 * of", "why us". The point of it being here rather than in a general chatbot
 * is that it already has the CV and the posting, so the answer is about this
 * candidate and this job without anything being pasted in first.
 *
 * The thread is NOT held in state here. It is whatever the server last
 * rendered, plus -- while a turn is in flight -- the message just typed,
 * carried by useOptimistic.
 *
 * That distinction is the whole correctness of this component. A useState
 * copy initialises once and then ignores every later render, so the reply
 * would land in the database and never reach the screen until the page was
 * reloaded by hand; the typed message would also be duplicated, once by the
 * local copy and once by the server. useOptimistic drops its addition as
 * soon as the real thread arrives, so both problems go away together.
 *
 * The optimistic echo still matters: a drafting turn takes ten seconds or
 * more, and a form that sits there looking unclicked gets clicked again.
 */
export function ApplicationChat({
  jobId,
  initialMessages,
  hasCv,
}: {
  jobId: string;
  initialMessages: Message[];
  hasCv: boolean;
}) {
  const [error, setError] = useState("");
  const [pending, startTransition] = useTransition();
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const [messages, showPending] = useOptimistic(
    initialMessages,
    (thread: Message[], typed: string) => [
      ...thread,
      { id: "in-flight", role: "user" as const, content: typed, unsupported: [] },
    ],
  );

  function submit(formData: FormData) {
    const text = String(formData.get("message") ?? "").trim();
    if (!text) return;

    if (inputRef.current) inputRef.current.value = "";

    startTransition(async () => {
      setError("");
      // Inside the transition: an optimistic update outside one is discarded
      // immediately, and the typed message would flash and vanish.
      showPending(text);

      const result = await sendMessage(jobId, text);
      if (result.status === "error") {
        // The message itself was stored before the model was called, so it
        // survives; the server render will show it with the error beneath.
        setError(result.message);
      }
    });
  }

  /**
   * A question with no answer under it.
   *
   * The question is stored before the model is called, so a turn that never
   * came back -- rate-limited past its retries, timed out, server restarted,
   * tab closed -- leaves one sitting there. Without saying so, the panel just
   * looks broken: no answer, no error, no way to tell whether it is still
   * thinking.
   */
  const unanswered =
    !pending && messages.length > 0 && messages[messages.length - 1].role === "user";

  function retry() {
    startTransition(async () => {
      setError("");
      const result = await retryLast(jobId);
      if (result.status === "error") setError(result.message);
    });
  }

  function reset() {
    startTransition(async () => {
      setError("");
      await clearThread(jobId);
    });
  }

  if (!hasCv) {
    return (
      <section className="card mt-8 p-6">
        <h2 className="font-semibold">Application questions</h2>
        <p className="hint mt-2">
          Upload a CV first — the answers are drawn from it, which is the whole point.
        </p>
      </section>
    );
  }

  return (
    <section className="card mt-8 p-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Application questions</h2>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={reset}
            disabled={pending}
            className="text-sm text-ink-soft hover:underline"
          >
            Clear
          </button>
        )}
      </div>

      <p className="hint">
        Paste a question from the application form. Answers come from your CV and this posting,
        and nothing is claimed that your CV does not show.
      </p>

      {messages.length === 0 && (
        <ul className="mt-4 space-y-1 text-sm text-ink-soft">
          <li>· &ldquo;A model you trained — the problem, approach, and how you measured success&rdquo;</li>
          <li>· &ldquo;Something you have built that you are most proud of&rdquo;</li>
          <li>· &ldquo;Why do you want to work here?&rdquo;</li>
        </ul>
      )}

      {messages.length > 0 && (
        <ol className="mt-5 space-y-4">
          {messages.map((message) => (
            <li key={message.id}>
              {message.role === "user" ? (
                <p className="rounded-lg bg-canvas px-3 py-2 text-sm font-medium">
                  {message.content}
                </p>
              ) : (
                <div>
                  {/* whitespace-pre-wrap: the drafts come back as paragraphs
                      and are meant to be copied into a form as written. */}
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p>

                  {message.unsupported.length > 0 && (
                    <p className="hint mt-2">
                      Not in your CV: {message.unsupported.join(", ")}. Say so honestly, or pick
                      another example.
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => navigator.clipboard?.writeText(message.content)}
                    className="mt-2 text-xs font-medium text-brand hover:underline"
                  >
                    Copy
                  </button>
                </div>
              )}
            </li>
          ))}
        </ol>
      )}

      {pending && <p className="hint mt-4">Drafting…</p>}

      {unanswered && (
        <div className="mt-4 rounded-lg border border-line bg-canvas p-3">
          <p className="text-sm">
            That one did not come back. Your question is kept — nothing was lost.
          </p>
          <button
            type="button"
            onClick={retry}
            disabled={pending}
            className="btn-secondary mt-3 text-sm"
          >
            Answer it
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-danger">
          {error}
        </p>
      )}

      <form action={submit} className="mt-5">
        <label htmlFor="message" className="sr-only">
          The question from the application form
        </label>
        <textarea
          ref={inputRef}
          id="message"
          name="message"
          rows={3}
          required
          placeholder={
            messages.length === 0
              ? "Paste the question here…"
              : "Shorter. Use the compliance engine instead. Less formal."
          }
          className="field"
          onKeyDown={(event) => {
            // Enter sends, Shift+Enter makes a new line -- the convention
            // every chat box uses, and the one people's hands expect.
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <button type="submit" disabled={pending} className="btn-primary mt-3 text-sm">
          {pending ? "Drafting…" : messages.length === 0 ? "Draft an answer" : "Send"}
        </button>
      </form>
    </section>
  );
}
