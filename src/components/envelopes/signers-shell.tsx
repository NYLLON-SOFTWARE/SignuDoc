"use client";

import { useRef, useState, type ChangeEvent } from "react";

import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from "@/components/layout/nav-items";
import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import { StepIndicator } from "@/components/shared/step-indicator";
import type { DraftSignerStepData } from "@/lib/envelopes";
import {
  duplicateSignerEmailMessage,
  type ReplaceSignersResponse,
} from "@/lib/schemas/signer";
import { MAX_SIGNERS_PER_ENVELOPE } from "@/lib/types/domain";
import { getSignerPalette } from "./signer-palette";

const envelopeSteps = ["Upload", "Signers", "Place fields", "Review"];
const validEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const genericSubmitError = "Something went wrong. Please try again.";

type SignersShellProps = {
  envelopeId: string;
  initialState?: "error";
  record?: DraftSignerStepData;
};

type SignerField = "email" | "name";

type SignerChecks = {
  /** A new code typed by the sender. Empty means "no change". */
  accessCode: string;
  /** A code is saved on the server. */
  hasAccessCode: boolean;
  removeAccessCode: boolean;
  requireEmailCode: boolean;
};

type ShellSigner = SignerChecks & {
  email: string;
  localId: string;
  name: string;
  signerId?: string;
  touched: Record<SignerField, boolean>;
};

type SignerErrors = {
  accessCode?: string;
  email?: string;
  name?: string;
};

type InitialModel = {
  showAllErrors: boolean;
  signers: ShellSigner[];
};

function createSigner(
  localId: string,
  overrides?: Partial<Omit<ShellSigner, "localId" | "touched">> & {
    touched?: Partial<Record<SignerField, boolean>>;
  },
): ShellSigner {
  return {
    accessCode: "",
    email: overrides?.email ?? "",
    hasAccessCode: overrides?.hasAccessCode ?? false,
    localId,
    removeAccessCode: false,
    requireEmailCode: overrides?.requireEmailCode ?? false,
    name: overrides?.name ?? "",
    signerId: overrides?.signerId,
    touched: {
      email: overrides?.touched?.email ?? false,
      name: overrides?.touched?.name ?? false,
    },
  };
}

function buildInitialModel(record?: DraftSignerStepData): InitialModel {
  const signers =
    record?.signers
      .slice()
      .sort((left, right) => left.order - right.order)
      .map((signer) =>
        createSigner(signer.id, {
          email: signer.email,
          hasAccessCode: signer.hasAccessCode,
          name: signer.name,
          requireEmailCode: signer.requireEmailCode,
          signerId: signer.id,
          touched: { email: true, name: true },
        }),
      ) ?? [];

  return {
    showAllErrors: false,
    signers: signers.length > 0 ? signers : [createSigner("signer-1")],
  };
}

function buildSignerErrors(signers: readonly ShellSigner[]) {
  const errorsBySignerId: Record<string, SignerErrors> = {};
  const emailCounts = signers.reduce<Record<string, number>>(
    (counts, signer) => {
      const normalizedEmail = signer.email.trim().toLowerCase();

      if (normalizedEmail.length > 0) {
        counts[normalizedEmail] = (counts[normalizedEmail] ?? 0) + 1;
      }

      return counts;
    },
    {},
  );

  for (const signer of signers) {
    const signerErrors: SignerErrors = {};
    const normalizedName = signer.name.trim();
    const normalizedEmail = signer.email.trim().toLowerCase();

    if (normalizedName.length === 0) {
      signerErrors.name = "Name is required";
    }

    if (
      normalizedEmail.length === 0 ||
      !validEmailPattern.test(normalizedEmail)
    ) {
      signerErrors.email = "Enter a valid email address";
    } else if (emailCounts[normalizedEmail] > 1) {
      signerErrors.email = duplicateSignerEmailMessage;
    }

    const accessCode = signer.accessCode.trim();

    if (
      accessCode.length > 0 &&
      (accessCode.length < 4 || accessCode.length > 64)
    ) {
      signerErrors.accessCode = "Use 4 to 64 characters";
    }

    errorsBySignerId[signer.localId] = signerErrors;
  }

  return errorsBySignerId;
}

function hasSignerErrors(errors: SignerErrors) {
  return Boolean(errors.name || errors.email || errors.accessCode);
}

function reorderSigners(
  signers: ShellSigner[],
  signerLocalId: string,
  direction: "earlier" | "later",
) {
  const signerIndex = signers.findIndex(
    (signer) => signer.localId === signerLocalId,
  );

  if (signerIndex === -1) {
    return signers;
  }

  const targetIndex =
    direction === "earlier" ? signerIndex - 1 : signerIndex + 1;

  if (targetIndex < 0 || targetIndex >= signers.length) {
    return signers;
  }

  const nextSigners = [...signers];
  const [movedSigner] = nextSigners.splice(signerIndex, 1);
  nextSigners.splice(targetIndex, 0, movedSigner);
  return nextSigners;
}

function buildSignerRequest(signers: readonly ShellSigner[]) {
  return {
    signers: signers.map((signer, index) => ({
      accessCode:
        signer.accessCode.trim().length > 0
          ? signer.accessCode.trim()
          : signer.removeAccessCode
            ? null
            : undefined,
      email: signer.email,
      id: signer.signerId,
      name: signer.name,
      requireEmailCode: signer.requireEmailCode,
      signOrder: index + 1,
    })),
  };
}

async function parseJsonResponse<T>(
  response: Response,
): Promise<{ data: T | null; error: string | null }> {
  const payload = (await response.json().catch(() => null)) as
    { error?: string } | T | null;

  if (!response.ok) {
    return {
      data: null,
      error:
        payload &&
        typeof payload === "object" &&
        "error" in payload &&
        typeof payload.error === "string"
          ? payload.error
          : genericSubmitError,
    };
  }

  return {
    data: payload as T | null,
    error: null,
  };
}

function SignerCard({
  canMoveEarlier,
  canMoveLater,
  canRemove,
  disabled = false,
  emailError,
  index,
  nameError,
  onChange,
  onBlur,
  onChecksChange,
  onMove,
  onRemove,
  accessCodeError,
  signer,
}: {
  accessCodeError?: string;
  onChecksChange: (patch: Partial<SignerChecks>) => void;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  canRemove: boolean;
  disabled?: boolean;
  emailError?: string;
  index: number;
  nameError?: string;
  onChange: (field: SignerField, value: string) => void;
  onBlur: (field: SignerField) => void;
  onMove: (direction: "earlier" | "later") => void;
  onRemove: () => void;
  signer: ShellSigner;
}) {
  const palette = getSignerPalette(index);
  const order = index + 1;
  const routeLabel =
    order === 1
      ? "Receives the invitation immediately after send."
      : `Receives the document after Signer ${order - 1} finishes.`;

  return (
    <li className="well p-4 sm:p-5">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <span
              className="pill"
              style={{
                backgroundColor: palette.tint,
                color: palette.color,
              }}
            >
              <span
                aria-hidden="true"
                className="size-2 rounded-full"
                style={{ backgroundColor: palette.color }}
              />
              Signer {order}
            </span>
            <p className="text-[0.8125rem] leading-5 text-(--secondary)">
              {routeLabel}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              aria-label={`Move signer ${order} earlier`}
              className="btn-quiet"
              disabled={disabled || !canMoveEarlier}
              onClick={() => onMove("earlier")}
              type="button"
            >
              <ChevronLeftIcon aria-hidden="true" className="-ml-1 size-4" />
              Earlier
            </button>
            <button
              aria-label={`Move signer ${order} later`}
              className="btn-quiet"
              disabled={disabled || !canMoveLater}
              onClick={() => onMove("later")}
              type="button"
            >
              Later
              <ChevronRightIcon aria-hidden="true" className="-mr-1 size-4" />
            </button>
            <button
              aria-label={`Remove signer ${order}`}
              className="btn-quiet btn-quiet-danger"
              disabled={disabled || !canRemove}
              onClick={onRemove}
              type="button"
            >
              Remove
            </button>
          </div>
        </div>

        <div className="grid gap-x-4 gap-y-1 md:grid-cols-2">
          <label className="grid auto-rows-min gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-(--secondary)">
              Name
            </span>
            <input
              aria-invalid={nameError ? true : undefined}
              aria-label={`Signer ${order} name`}
              className="field-input"
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                onChange("name", event.target.value)
              }
              onBlur={() => onBlur("name")}
              placeholder="Jane Smith"
              type="text"
              value={signer.name}
            />
            <span
              aria-live="polite"
              className={`min-h-4 text-xs font-semibold text-(--danger) ${
                nameError ? "" : "invisible"
              }`}
              role={nameError ? "alert" : undefined}
            >
              {nameError ?? " "}
            </span>
          </label>

          <label className="grid auto-rows-min gap-1.5">
            <span className="text-[0.8125rem] font-semibold text-(--secondary)">
              Email
            </span>
            <input
              aria-invalid={emailError ? true : undefined}
              aria-label={`Signer ${order} email`}
              className="field-input"
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                onChange("email", event.target.value)
              }
              onBlur={() => onBlur("email")}
              placeholder="jane@company.com"
              type="email"
              value={signer.email}
            />
            <span
              aria-live="polite"
              className={`min-h-4 text-xs font-semibold text-(--danger) ${
                emailError ? "" : "invisible"
              }`}
              role={emailError ? "alert" : undefined}
            >
              {emailError ?? " "}
            </span>
          </label>
        </div>

        <fieldset className="grid gap-3 rounded-2xl bg-white p-4 text-sm text-(--fg) sm:p-5">
          <legend className="sr-only">Extra check before signing</legend>
          <p className="font-bold text-(--fg)">
            Extra check before signing{" "}
            <span className="font-normal text-(--secondary)">(optional)</span>
          </p>
          <p className="text-[0.8125rem] leading-5 text-(--secondary)">
            By default anyone holding the emailed link can sign. Add a check
            when the signer&apos;s identity matters.
          </p>
          <label className="flex items-start gap-3">
            <input
              aria-label={`Email signer ${order} a one-time code`}
              checked={signer.requireEmailCode}
              className="mt-0.5 size-4.5 shrink-0 cursor-pointer accent-(--accent)"
              disabled={disabled}
              onChange={(event: ChangeEvent<HTMLInputElement>) =>
                onChecksChange({ requireEmailCode: event.target.checked })
              }
              type="checkbox"
            />
            <span>Email a one-time code when they open the link</span>
          </label>
          <label className="grid gap-2">
            <span className="text-[0.8125rem] font-semibold text-(--secondary)">
              Access code you will give them yourself, for example by phone
              {signer.hasAccessCode && !signer.removeAccessCode
                ? " (a code is set; type a new one to change it)"
                : ""}
            </span>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                aria-invalid={accessCodeError ? true : undefined}
                aria-label={`Signer ${order} access code`}
                autoComplete="off"
                className="field-input flex-1"
                disabled={disabled}
                maxLength={64}
                onChange={(event: ChangeEvent<HTMLInputElement>) =>
                  onChecksChange({
                    accessCode: event.target.value,
                    removeAccessCode: false,
                  })
                }
                placeholder={
                  signer.hasAccessCode && !signer.removeAccessCode
                    ? "••••••"
                    : "No access code"
                }
                type="text"
                value={signer.accessCode}
              />
              {signer.hasAccessCode && !signer.removeAccessCode ? (
                <button
                  className="btn-quiet btn-quiet-danger min-h-12"
                  disabled={disabled}
                  onClick={() =>
                    onChecksChange({ accessCode: "", removeAccessCode: true })
                  }
                  type="button"
                >
                  Remove code
                </button>
              ) : null}
            </div>
            {accessCodeError ? (
              <span
                className="text-xs font-semibold text-(--danger)"
                role="alert"
              >
                {accessCodeError}
              </span>
            ) : null}
          </label>
        </fieldset>
      </div>
    </li>
  );
}

export function SignersShell({
  envelopeId,
  initialState,
  record,
}: SignersShellProps) {
  const initialModel = buildInitialModel(record);
  const [signers, setSigners] = useState(initialModel.signers);
  const [showAllErrors, setShowAllErrors] = useState(
    initialModel.showAllErrors,
  );
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const nextSignerNumberRef = useRef(initialModel.signers.length + 1);

  const errorsBySignerId = buildSignerErrors(signers);
  const canAddSigner = signers.length < MAX_SIGNERS_PER_ENVELOPE;
  const canContinue =
    signers.length > 0 &&
    signers.every(
      (signer) => !hasSignerErrors(errorsBySignerId[signer.localId] ?? {}),
    );

  function clearSubmitError() {
    setSubmissionError(null);
  }

  function handleSignerChange(
    signerLocalId: string,
    field: SignerField,
    value: string,
  ) {
    clearSubmitError();
    setShowAllErrors(false);
    setSigners((currentSigners) =>
      currentSigners.map((signer) =>
        signer.localId === signerLocalId
          ? {
              ...signer,
              [field]: value,
            }
          : signer,
      ),
    );
  }

  function handleSignerChecksChange(
    signerLocalId: string,
    patch: Partial<SignerChecks>,
  ) {
    clearSubmitError();
    setSigners((currentSigners) =>
      currentSigners.map((signer) =>
        signer.localId === signerLocalId ? { ...signer, ...patch } : signer,
      ),
    );
  }

  function handleSignerBlur(signerLocalId: string, field: SignerField) {
    setSigners((currentSigners) =>
      currentSigners.map((signer) =>
        signer.localId === signerLocalId
          ? {
              ...signer,
              touched: {
                ...signer.touched,
                [field]: true,
              },
            }
          : signer,
      ),
    );
  }

  function handleAddSigner() {
    if (!canAddSigner || isSubmitting) {
      return;
    }

    clearSubmitError();
    const nextSignerNumber = nextSignerNumberRef.current;
    nextSignerNumberRef.current += 1;
    setSigners((currentSigners) => [
      ...currentSigners,
      createSigner(`signer-${nextSignerNumber}`),
    ]);
  }

  function handleRemoveSigner(signerLocalId: string) {
    if (isSubmitting) {
      return;
    }

    clearSubmitError();
    setSigners((currentSigners) =>
      currentSigners.length === 1
        ? currentSigners
        : currentSigners.filter((signer) => signer.localId !== signerLocalId),
    );
  }

  function handleMoveSigner(
    signerLocalId: string,
    direction: "earlier" | "later",
  ) {
    if (isSubmitting) {
      return;
    }

    clearSubmitError();
    setSigners((currentSigners) =>
      reorderSigners(currentSigners, signerLocalId, direction),
    );
  }

  async function handleContinue() {
    setShowAllErrors(true);

    if (!canContinue || isSubmitting) {
      return;
    }

    clearSubmitError();
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/envelopes/${envelopeId}/signers`, {
        body: JSON.stringify(buildSignerRequest(signers)),
        headers: {
          "content-type": "application/json",
        },
        method: "PUT",
      });
      const payload = await parseJsonResponse<ReplaceSignersResponse>(response);

      if (payload.error) {
        setSubmissionError(payload.error);
        return;
      }

      window.location.assign(
        payload.data?.redirectPath ?? `/envelopes/${envelopeId}/prepare`,
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  if (initialState === "error") {
    return (
      <div className="space-y-5">
        <PageHeader
          description="Step 2 of 4 - Add signers"
          title="New envelope"
        />
        <StepIndicator current={2} steps={envelopeSteps} />
        <StatusPanel
          action={{
            href: `/envelopes/${envelopeId}/signers`,
            label: "Retry",
          }}
          description="We couldn't load this draft's signer list. Try again and confirm the upload step completed successfully."
          title="Couldn't load signer setup"
          tone="error"
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        description="Step 2 of 4 - Add signers"
        title="New envelope"
      />

      <StepIndicator current={2} steps={envelopeSteps} />

      <section
        className="panel p-5 sm:p-8"
        data-animate="enter"
        data-animate-delay="2"
      >
        <div className="space-y-5">
          <div className="space-y-1">
            <h2 className="text-lg font-extrabold text-(--fg)">
              Signers will receive the document in this order.
            </h2>
            <p className="text-sm leading-6 text-(--secondary)">
              Up to 10 signers per document.
            </p>
          </div>

          {submissionError ? (
            <div className="notice notice-danger" role="alert">
              <p>{submissionError}</p>
            </div>
          ) : null}

          <ol className="space-y-3">
            {signers.map((signer, index) => {
              const signerErrors = errorsBySignerId[signer.localId] ?? {};
              const nameError =
                showAllErrors || signer.touched.name
                  ? signerErrors.name
                  : undefined;
              const emailError =
                showAllErrors || signer.touched.email
                  ? signerErrors.email
                  : undefined;

              return (
                <SignerCard
                  canMoveEarlier={index > 0}
                  canMoveLater={index < signers.length - 1}
                  canRemove={signers.length > 1}
                  disabled={isSubmitting}
                  emailError={emailError}
                  index={index}
                  key={signer.localId}
                  nameError={nameError}
                  onChange={(field, value) =>
                    handleSignerChange(signer.localId, field, value)
                  }
                  onBlur={(field) => handleSignerBlur(signer.localId, field)}
                  accessCodeError={errorsBySignerId[signer.localId]?.accessCode}
                  onChecksChange={(patch) =>
                    handleSignerChecksChange(signer.localId, patch)
                  }
                  onMove={(direction) =>
                    handleMoveSigner(signer.localId, direction)
                  }
                  onRemove={() => handleRemoveSigner(signer.localId)}
                  signer={signer}
                />
              );
            })}
          </ol>

          <div className="flex flex-wrap items-center gap-3">
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[0.875rem] bg-(--accent-soft) px-4.5 text-sm font-bold text-(--accent-ink) transition hover:bg-[#e0dbfb] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={!canAddSigner || isSubmitting}
              onClick={handleAddSigner}
              type="button"
            >
              + Add another signer
            </button>
            {!canAddSigner ? (
              <p className="text-[0.8125rem] font-semibold text-(--tertiary)">
                Maximum reached
              </p>
            ) : null}
          </div>

          <div className="flex flex-col-reverse gap-3 pt-2 sm:flex-row sm:justify-end">
            <ShellButton href="/envelopes/new" variant="secondary">
              ← Back
            </ShellButton>
            <ShellButton
              disabled={!canContinue}
              loading={isSubmitting}
              onClick={handleContinue}
            >
              Next →
            </ShellButton>
          </div>
        </div>
      </section>
    </div>
  );
}
