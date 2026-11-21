"use client";

import { useState } from "react";

import { preferenceCheckboxLabel } from "@/components/settings/preference-label";
import { ShellButton } from "@/components/shared/form-shell";
import type { NotificationPreferencesView } from "@/lib/notifications/settings";

// Settings, My notifications, for everyone: which events about the
// envelopes you send get you a direct message. Slack finds you by your
// email address here.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type Feedback = { message: string; tone: "error" | "success" } | null;

export function NotificationPreferencesPanel({
  initialView,
}: {
  initialView: NotificationPreferencesView;
}) {
  const [view, setView] = useState(initialView);
  const channel = view.channels.find((item) => item.id === "slack") ?? null;
  const [choices, setChoices] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (channel?.choices ?? []).map((choice) => [choice.event, choice.enabled]),
    ),
  );
  const [pending, setPending] = useState<"save" | "test" | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);

  if (!channel) {
    return null;
  }

  async function save() {
    if (!channel) {
      return;
    }

    setPending("save");
    setFeedback(null);

    try {
      const response = await fetch("/api/account/notifications", {
        body: JSON.stringify({
          channel: channel.id,
          preferences: channel.choices.map((choice) => ({
            enabled: choices[choice.event] ?? choice.enabled,
            event: choice.event,
          })),
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        view?: NotificationPreferencesView;
      } | null;

      if (!response.ok || !payload?.view) {
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setView(payload.view);
      setFeedback({ message: "Saved.", tone: "success" });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setPending(null);
    }
  }

  async function test() {
    setPending("test");
    setFeedback(null);

    try {
      const response = await fetch("/api/account/notifications", {
        body: JSON.stringify({ action: "test_slack_message" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        result?: { message: string; ok: boolean };
      } | null;

      if (!payload?.result) {
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setFeedback({
        message: payload.result.message,
        tone: payload.result.ok ? "success" : "error",
      });
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setPending(null);
    }
  }

  return (
    <section
      className="panel scroll-mt-6 space-y-6 p-6 sm:p-8"
      data-animate="enter"
      id="my-notifications"
    >
      <div className="space-y-2">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          My notifications
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Choose what {channel.name} sends you a direct message about, for the
          envelopes you send. It finds you by the email address of this account,
          so your {channel.name} account needs the same one. Messages name the
          document and who did what, and link here; they never include the
          document itself.
        </p>
      </div>

      {channel.available ? null : (
        <p className="notice notice-warning">
          Direct messages from {channel.name} are not set up on this site yet.
          Your choices are kept for when they are.
        </p>
      )}

      {feedback ? (
        <p
          className={`notice ${feedback.tone === "success" ? "notice-success" : "notice-danger"}`}
          role={feedback.tone === "error" ? "alert" : "status"}
        >
          {feedback.message}
        </p>
      ) : null}

      <ul className="grid gap-3 sm:grid-cols-2">
        {view.events.map((event) => (
          <li key={event.kind}>
            <label className="flex items-start gap-3 text-sm">
              <input
                aria-label={preferenceCheckboxLabel(event)}
                checked={choices[event.kind] ?? false}
                className="mt-1 size-4 accent-(--accent)"
                disabled={pending !== null}
                onChange={(change) => {
                  const checked = change.target.checked;

                  setChoices((current) => ({
                    ...current,
                    [event.kind]: checked,
                  }));
                  setFeedback(null);
                }}
                type="checkbox"
              />
              <span>
                <span className="block font-semibold text-(--fg)">
                  {event.label}
                </span>
                <span className="block text-(--secondary)">
                  {event.description}
                </span>
              </span>
            </label>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap gap-3">
        <ShellButton loading={pending === "save"} onClick={() => void save()}>
          {pending === "save" ? "Saving..." : "Save my notifications"}
        </ShellButton>
        {channel.available ? (
          <ShellButton
            loading={pending === "test"}
            onClick={() => void test()}
            variant="secondary"
          >
            {pending === "test" ? "Sending..." : "Send me a test message"}
          </ShellButton>
        ) : null}
      </div>
    </section>
  );
}
