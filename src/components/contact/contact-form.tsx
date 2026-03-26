"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import {
  Field,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";
import { contactFormSchema } from "@/lib/schemas/contact";

type ContactFormValues = {
  company: string;
  email: string;
  message: string;
  name: string;
};

type ContactFormErrors = Partial<
  Record<Exclude<keyof ContactFormValues, "company">, string>
>;

type ContactApiPayload = {
  error?: string;
  fieldErrors?: Partial<Record<string, string>>;
} | null;

const defaultValues: ContactFormValues = {
  company: "",
  email: "",
  message: "",
  name: "",
};

function readApiErrorMessage(payload: ContactApiPayload): string {
  if (typeof payload?.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  return "Something went wrong. Please try again.";
}

export function ContactForm() {
  const [values, setValues] = useState<ContactFormValues>(defaultValues);
  const [errors, setErrors] = useState<ContactFormErrors>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function handleChange(field: keyof ContactFormValues) {
    return (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({
        ...currentValues,
        [field]: nextValue,
      }));

      if (field !== "company") {
        setErrors((currentErrors) => ({
          ...currentErrors,
          [field]: undefined,
        }));
      }

      setSubmitError(null);
      setSuccessMessage(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const submittedValues = {
      company: String(formData.get("company") ?? values.company),
      email: String(formData.get("contact-email") ?? values.email),
      message: String(formData.get("contact-message") ?? values.message),
      name: String(formData.get("contact-name") ?? values.name),
    };
    const validationResult = contactFormSchema.safeParse(submittedValues);

    if (!validationResult.success) {
      const nextErrors: ContactFormErrors = {};

      for (const issue of validationResult.error.issues) {
        const field = issue.path[0];

        if (field === "name") {
          nextErrors.name = "Enter your name";
        }

        if (field === "email") {
          nextErrors.email = "Enter a valid email address";
        }

        if (field === "message") {
          nextErrors.message =
            issue.code === "too_big"
              ? "Message must be 5000 characters or fewer"
              : "Enter a message";
        }
      }

      setValues(submittedValues);
      setErrors(nextErrors);
      setSubmitError(null);
      setSuccessMessage(null);
      return;
    }

    setValues(validationResult.data);
    setErrors({});
    setSubmitError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/contact", {
        body: JSON.stringify(validationResult.data),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as ContactApiPayload;

      if (!response.ok) {
        setErrors({
          email:
            typeof payload?.fieldErrors?.email === "string"
              ? payload.fieldErrors.email
              : undefined,
          message:
            typeof payload?.fieldErrors?.message === "string"
              ? payload.fieldErrors.message
              : undefined,
          name:
            typeof payload?.fieldErrors?.name === "string"
              ? payload.fieldErrors.name
              : undefined,
        });
        setSubmitError(readApiErrorMessage(payload));
        return;
      }

      setValues(defaultValues);
      setErrors({});
      setSuccessMessage(
        `Your message was sent. We’ll follow up at ${validationResult.data.email} if we need more detail.`,
      );
    } catch {
      setSubmitError("Something went wrong. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <section className="border border-(--border) bg-white p-6 sm:p-8">
      <form className="space-y-5" onSubmit={handleSubmit}>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -left-[10000px] top-auto h-px w-px overflow-hidden"
        >
          <label htmlFor="company">Company</label>
          <input
            autoComplete="off"
            id="company"
            name="company"
            onChange={handleChange("company")}
            tabIndex={-1}
            value={values.company}
          />
        </div>

        {successMessage ? (
          <div className="rounded-[24px] border border-[rgba(36,109,78,0.2)] bg-[rgba(36,109,78,0.08)] px-4 py-3 text-sm text-[rgb(36,109,78)]">
            {successMessage}
          </div>
        ) : null}

        {submitError ? (
          <div className="rounded-[24px] border border-[rgba(180,35,53,0.18)] bg-[rgba(180,35,53,0.08)] px-4 py-3 text-sm text-(--accent)">
            {submitError}
          </div>
        ) : null}

        <div className="grid gap-5 sm:grid-cols-2">
          <FieldShell
            autoComplete="name"
            disabled={isSubmitting}
            error={errors.name}
            label="Name"
            name="contact-name"
            onChange={handleChange("name")}
            placeholder="Your name"
            readOnly={false}
            value={values.name}
          />
          <FieldShell
            autoComplete="email"
            disabled={isSubmitting}
            error={errors.email}
            label="Email"
            name="contact-email"
            onChange={handleChange("email")}
            placeholder="you@example.com"
            readOnly={false}
            type="email"
            value={values.email}
          />
        </div>

        <Field className="gap-2 text-sm">
          <FieldLabel
            className="text-[0.84rem] font-semibold tracking-[-0.02em] text-(--fg)"
            htmlFor="contact-message"
          >
            Message
          </FieldLabel>
          <Textarea
            aria-describedby="contact-message-description"
            aria-invalid={errors.message ? true : undefined}
            className={errors.message ? "border-[rgba(180,35,53,0.36)]" : ""}
            disabled={isSubmitting}
            id="contact-message"
            name="contact-message"
            onChange={handleChange("message")}
            placeholder="Tell us what you need, and include any account email, sender name, document title, or link that helps us identify the request."
            value={values.message}
          />
          {errors.message ? (
            <FieldError
              className="text-xs font-semibold text-(--accent)"
              id="contact-message-description"
            >
              {errors.message}
            </FieldError>
          ) : null}
        </Field>

        <div className="flex border-t border-(--border) pt-5 sm:justify-end">
          <ShellButton loading={isSubmitting} type="submit">
            {isSubmitting ? "Sending..." : "Send message"}
          </ShellButton>
        </div>
      </form>
    </section>
  );
}
