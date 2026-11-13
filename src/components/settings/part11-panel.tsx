"use client";

import { useEffect, useState } from "react";

import type { SystemAuditEvent } from "@/lib/services/system-audit";

// Part 11 mode and the install's own audit trail. Administrators only.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type AuditResponse = {
  chain?:
    | { events: number; ok: true }
    | { brokenAtSequence: number; events: number; ok: false };
  error?: string;
  events?: SystemAuditEvent[];
} | null;

const EVENT_LABELS: Record<SystemAuditEvent["event"], string> = {
  identity_verification_revoked: "Identity confirmation taken back",
  identity_verified: "Identity confirmed",
  part11_mode_changed: "Part 11 mode changed",
  reauthentication_failed: "Wrong password while signing",
  role_changed: "Role changed",
  settings_changed: "Settings changed",
  signing_locked: "Signing locked",
  signing_unlocked: "Signing unlocked",
};

function describeEvent(event: SystemAuditEvent): string {
  const metadata = event.metadata ?? {};
  const target =
    typeof metadata.targetName === "string"
      ? `${metadata.targetName}${typeof metadata.targetEmail === "string" ? ` <${metadata.targetEmail}>` : ""}`
      : null;

  switch (event.event) {
    case "part11_mode_changed":
      return metadata.to === true ? "Turned on" : "Turned off";
    case "role_changed":
      return `${target ?? "Account"}: ${String(metadata.from)} to ${String(metadata.to)}`;
    case "settings_changed":
      return typeof metadata.changes === "object" && metadata.changes
        ? Object.keys(metadata.changes).join(", ")
        : "";
    case "identity_verified":
      return `${target ?? ""}${typeof metadata.note === "string" ? `: ${metadata.note}` : ""}`;
    case "reauthentication_failed":
    case "signing_locked":
      return typeof metadata.failedAttempts === "number"
        ? `${String(metadata.failedAttempts)} wrong in a row`
        : "";
    default:
      return target ?? "";
  }
}

export function Part11Panel({ initialEnabled }: { initialEnabled: boolean }) {
  const enabled = initialEnabled;
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [audit, setAudit] = useState<AuditResponse>(null);
  const [auditRevision, setAuditRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/audit", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as AuditResponse;

        setAudit(
          response.ok
            ? payload
            : { error: payload?.error ?? GENERIC_ERROR_MESSAGE },
        );
      })
      .catch((loadError: unknown) => {
        if (!(
          loadError instanceof DOMException && loadError.name === "AbortError"
        )) {
          setAudit({ error: GENERIC_ERROR_MESSAGE });
        }
      });

    return () => controller.abort();
  }, [auditRevision]);

  async function changeMode(next: boolean) {
    setIsSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/admin/part11", {
        body: JSON.stringify({ enabled: next }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        part11Mode?: boolean;
      } | null;

      if (!response.ok || typeof payload?.part11Mode !== "boolean") {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      // The People list and the retention field depend on the mode.
      window.location.reload();
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="space-y-5 border-t border-(--border) pt-8" id="part11">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          FDA 21 CFR Part 11 mode
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          For regulated records. While it is on, envelopes are sent only to
          people with an account here whose identity an administrator has
          confirmed under People. Each signer gives their email address and
          password to open the document and again to sign, and confirms what the
          signature means, which is printed beside it with their name and the
          time. Five wrong passwords lock the account for signing and email the
          administrators. Finished envelopes are never deleted by the retention
          period or a data request, and a void needs a reason.
        </p>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Turning it on does not by itself make this site compliant. Your
          organization still validates the system, writes and follows its own
          procedures, trains its people and certifies its electronic signatures
          to the FDA.
        </p>
      </div>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <span className={`pill ${enabled ? "pill-success" : "pill-neutral"}`}>
          {enabled ? "On" : "Off"}
        </span>
        <button
          className={enabled ? "btn-quiet btn-quiet-danger" : "btn-quiet"}
          disabled={isSaving}
          onClick={() => void changeMode(!enabled)}
          type="button"
        >
          {isSaving
            ? "Saving..."
            : enabled
              ? "Turn off Part 11 mode"
              : "Turn on Part 11 mode"}
        </button>
      </div>

      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h4 className="text-[0.9375rem] font-bold text-(--fg)">
            Site audit trail
          </h4>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn-quiet"
              onClick={() => setAuditRevision((value) => value + 1)}
              type="button"
            >
              Refresh
            </button>
            <a className="btn-quiet" href="/api/admin/audit?format=csv">
              Download as CSV
            </a>
          </div>
        </div>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Changes to settings, roles, identity confirmations and signing locks.
          Each envelope has its own trail too, which its sender can export from
          the envelope&apos;s page.
        </p>

        {audit?.error ? (
          <div className="notice notice-danger" role="alert">
            {audit.error}
          </div>
        ) : null}

        {audit?.chain ? (
          <p
            className={`notice ${audit.chain.ok ? "notice-success" : "notice-danger"}`}
            role="status"
          >
            {audit.chain.ok
              ? `Hash chain intact across ${String(audit.chain.events)} events.`
              : `The hash chain is broken at event ${String(audit.chain.brokenAtSequence)}: a row was changed or removed.`}
          </p>
        ) : null}

        {audit?.events ? (
          audit.events.length === 0 ? (
            <p className="text-sm text-(--secondary)">Nothing recorded yet.</p>
          ) : (
            <ul aria-label="Site audit trail" className="space-y-2">
              {audit.events.map((event) => (
                <li className="well p-3 text-sm" key={event.id}>
                  <p className="font-semibold text-(--fg)">
                    {EVENT_LABELS[event.event] ?? event.event}
                    <span className="font-normal text-(--secondary)">
                      {" "}
                      {describeEvent(event)}
                    </span>
                  </p>
                  <p className="text-xs text-(--tertiary)">
                    {new Date(event.createdAt * 1000)
                      .toISOString()
                      .replace("T", " ")
                      .replace(/\.\d{3}Z$/, " UTC")}
                    {event.actorEmail ? ` · ${event.actorEmail}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )
        ) : null}
      </div>
    </div>
  );
}
