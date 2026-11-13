"use client";

import { useState, type FormEvent } from "react";

import { getSignerPalette } from "@/components/envelopes/signer-palette";
import { ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import { StatusPanel } from "@/components/shared/status-panel";
import { duplicateSignerEmailMessage } from "@/lib/schemas/signer";
import type { UseTemplateData } from "@/lib/templates";

type UseTemplateShellProps = {
  /** Shown in place of the form when the template cannot be used. */
  errorMessage?: string;
  template?: UseTemplateData;
};

type Person = {
  email: string;
  name: string;
};

type PersonErrors = {
  email?: string;
  name?: string;
};

const validEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const genericError = "Something went wrong. Please try again.";

function findErrors(people: readonly Person[]): PersonErrors[] {
  const emailCounts = new Map<string, number>();

  for (const person of people) {
    const email = person.email.trim().toLowerCase();

    if (email) {
      emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
    }
  }

  return people.map((person) => {
    const errors: PersonErrors = {};
    const email = person.email.trim().toLowerCase();

    if (person.name.trim().length === 0) {
      errors.name = "Name is required";
    }

    if (!validEmailPattern.test(email)) {
      errors.email = "Enter a valid email address";
    } else if ((emailCounts.get(email) ?? 0) > 1) {
      errors.email = duplicateSignerEmailMessage;
    }

    return errors;
  });
}

/** Names a person for each role of a template and starts a draft from it. */
export function UseTemplateShell({
  errorMessage,
  template,
}: UseTemplateShellProps) {
  const [title, setTitle] = useState(template?.name ?? "");
  const [people, setPeople] = useState<Person[]>(() =>
    (template?.roles ?? []).map(() => ({ email: "", name: "" })),
  );
  const [showErrors, setShowErrors] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  if (!template) {
    return (
      <div className="space-y-5">
        <PageHeader title="Use a template" />
        <StatusPanel
          action={{ href: "/templates", label: "Back to templates" }}
          description={
            errorMessage ??
            "We couldn't load this template. Try again in a moment."
          }
          title="This template can't be used"
          tone="error"
        />
      </div>
    );
  }

  const errors = findErrors(people);
  const titleError =
    title.trim().length === 0 ? "Give the envelope a title" : undefined;
  const canSubmit =
    !titleError && errors.every((error) => !error.name && !error.email);

  function updatePerson(index: number, patch: Partial<Person>) {
    setSubmitError(null);
    setPeople((current) =>
      current.map((person, personIndex) =>
        personIndex === index ? { ...person, ...patch } : person,
      ),
    );
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setShowErrors(true);

    if (!template || !canSubmit || isSubmitting) {
      return;
    }

    setSubmitError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch(`/api/templates/${template.id}/use`, {
        body: JSON.stringify({ signers: people, title }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        redirectPath?: string;
      } | null;

      if (!response.ok || !payload?.redirectPath) {
        setSubmitError(payload?.error ?? genericError);
        setIsSubmitting(false);
        return;
      }

      // The button stays busy until the next page takes over.
      window.location.assign(payload.redirectPath);
    } catch {
      setSubmitError(genericError);
      setIsSubmitting(false);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        description={`${template.name} · ${template.pageCountLabel} · ${template.fieldCountLabel}`}
        title="Use a template"
      />

      <form
        className="panel space-y-6 p-5 sm:p-8"
        data-animate="enter"
        data-animate-delay="1"
        noValidate
        onSubmit={handleSubmit}
      >
        <label className="grid max-w-xl gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Envelope title
          </span>
          <input
            aria-invalid={showErrors && titleError ? true : undefined}
            className="field-input"
            disabled={isSubmitting}
            maxLength={160}
            onChange={(event) => {
              setSubmitError(null);
              setTitle(event.target.value);
            }}
            type="text"
            value={title}
          />
          {showErrors && titleError ? (
            <span
              className="text-xs font-semibold text-(--danger)"
              role="alert"
            >
              {titleError}
            </span>
          ) : null}
        </label>

        <div className="space-y-3">
          <div className="space-y-1">
            <h2 className="text-lg font-extrabold text-(--fg)">
              Who is signing this time?
            </h2>
            <p className="text-sm leading-6 text-(--secondary)">
              They receive the document in this order. The fields are already
              placed for each of them.
            </p>
          </div>

          <ol className="space-y-3">
            {template.roles.map((role, index) => {
              const palette = getSignerPalette(index);
              const person = people[index] ?? { email: "", name: "" };
              const nameError = showErrors ? errors[index]?.name : undefined;
              const emailError = showErrors ? errors[index]?.email : undefined;

              return (
                <li className="well p-4 sm:p-5" key={role.id}>
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
                    {index + 1}. {role.name}
                  </span>

                  <div className="mt-3 grid gap-x-4 gap-y-3 md:grid-cols-2">
                    <label className="grid auto-rows-min gap-1.5">
                      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                        Name
                      </span>
                      <input
                        aria-invalid={nameError ? true : undefined}
                        aria-label={`${role.name} name`}
                        className="field-input"
                        disabled={isSubmitting}
                        maxLength={120}
                        onChange={(event) =>
                          updatePerson(index, { name: event.target.value })
                        }
                        placeholder="Jane Smith"
                        type="text"
                        value={person.name}
                      />
                      {nameError ? (
                        <span
                          className="text-xs font-semibold text-(--danger)"
                          role="alert"
                        >
                          {nameError}
                        </span>
                      ) : null}
                    </label>

                    <label className="grid auto-rows-min gap-1.5">
                      <span className="text-[0.8125rem] font-semibold text-(--secondary)">
                        Email
                      </span>
                      <input
                        aria-invalid={emailError ? true : undefined}
                        aria-label={`${role.name} email`}
                        className="field-input"
                        disabled={isSubmitting}
                        maxLength={320}
                        onChange={(event) =>
                          updatePerson(index, { email: event.target.value })
                        }
                        placeholder="jane@company.com"
                        type="email"
                        value={person.email}
                      />
                      {emailError ? (
                        <span
                          className="text-xs font-semibold text-(--danger)"
                          role="alert"
                        >
                          {emailError}
                        </span>
                      ) : null}
                    </label>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <p className="text-sm leading-6 text-(--secondary)">
          Nothing is sent yet. You will see the review step next, where you can
          still change the fields, add people who get a copy, or add an extra
          check before signing.
        </p>

        {submitError ? (
          <div className="notice notice-danger" role="alert">
            <p>{submitError}</p>
          </div>
        ) : null}

        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
          <ShellButton
            disabled={isSubmitting}
            href="/templates"
            variant="secondary"
          >
            Cancel
          </ShellButton>
          <ShellButton loading={isSubmitting} type="submit">
            {isSubmitting ? "Creating..." : "Create draft"}
          </ShellButton>
        </div>
      </form>
    </div>
  );
}
