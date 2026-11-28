"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, type ChangeEvent, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { ApiKeysPanel } from "@/components/settings/api-keys-panel";
import { BrandingPanel } from "@/components/settings/branding-panel";
import { EmbeddingPanel } from "@/components/settings/embedding-panel";
import { Part11Panel } from "@/components/settings/part11-panel";
import { PeoplePanel } from "@/components/settings/people-panel";
import { SecurityPanel } from "@/components/settings/security-panel";
import { SignerDataPanel } from "@/components/settings/signer-data-panel";
import { TeamsPanel } from "@/components/settings/teams-panel";
import { WebhooksPanel } from "@/components/settings/webhooks-panel";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
  CUSTOM_DISCLOSURE_LEGAL_NOTE,
  CUSTOM_DISCLOSURE_NOTICE,
  tidyDisclosureText,
} from "@/lib/consent-disclosure-notice";
import type { EmailDnsRecord, EmailStatus } from "@/lib/email-status";
import type {
  OrganizationSettingsField,
  OrganizationSettingsView,
} from "@/lib/organization-settings";
import type { SignupMode } from "@/lib/signup-policy";

// The administrator's part of Settings: what the install is called, who can
// sign up, where email comes from, and whether email works yet.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
const RESEND_DOMAINS_URL = "https://resend.com/domains";
const RESEND_MARKETPLACE_URL = "https://vercel.com/marketplace/resend";

type OrganizationSettingsProps = {
  initialSettings: OrganizationSettingsView;
};

type FormErrors = Partial<Record<OrganizationSettingsField, string>>;

type Feedback = {
  message: string;
  tone: "error" | "success";
} | null;

type SettingsResponse = {
  error?: string;
  fieldErrors?: FormErrors;
  settings?: OrganizationSettingsView;
} | null;

type EmailResponse = {
  error?: string;
  status?: EmailStatus;
  test?: { sent: true; to: string } | { sent: false; message: string };
} | null;

type EmailAction = "add_domain" | "recheck" | "send_test";

const signupModeOptions: Array<{
  description: string;
  label: string;
  value: SignupMode;
}> = [
  {
    description:
      "Only people whose email address is at one of your domains can create an account.",
    label: "People at my organization",
    value: "domains",
  },
  {
    description: "Nobody new can create an account.",
    label: "Nobody",
    value: "closed",
  },
  {
    description: "Anyone who finds this site can create an account.",
    label: "Anyone",
    value: "open",
  },
];

export function OrganizationSettings({
  initialSettings,
}: OrganizationSettingsProps) {
  const router = useRouter();
  const [values, setValues] = useState(initialSettings);
  const [errors, setErrors] = useState<FormErrors>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isSaving, setIsSaving] = useState(false);
  // Bumped after a save, so the email panel looks again: a new sender
  // address means a different domain to check.
  const [emailRevision, setEmailRevision] = useState(0);
  // The disclosure as last saved, to tell whether a save changes it.
  const [savedConsentDisclosure, setSavedConsentDisclosure] = useState(
    initialSettings.consentDisclosure,
  );
  const [isDisclosureNoticeOpen, setIsDisclosureNoticeOpen] = useState(false);

  function handleChange(field: OrganizationSettingsField) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({ ...currentValues, [field]: nextValue }));
      setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
      setFeedback(null);
    };
  }

  function setConsentDisclosure(consentDisclosure: string) {
    setValues((currentValues) => ({ ...currentValues, consentDisclosure }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      consentDisclosure: undefined,
    }));
    setFeedback(null);
  }

  function handleBrandColorChange(brandColor: string) {
    setValues((currentValues) => ({ ...currentValues, brandColor }));
    setErrors((currentErrors) => ({ ...currentErrors, brandColor: undefined }));
    setFeedback(null);
  }

  function handleSignupModeChange(signupMode: SignupMode) {
    setValues((currentValues) => ({ ...currentValues, signupMode }));
    setErrors((currentErrors) => ({
      ...currentErrors,
      allowedEmailDomains: undefined,
      signupMode: undefined,
    }));
    setFeedback(null);
  }

  /**
   * Whether saving puts the administrator's own words in place of what
   * signers read now, which needs them to agree to the notice first. Going
   * back to the standard text, or saving the same words again, does not.
   */
  function savingChangesToOwnDisclosure(): boolean {
    const next = tidyDisclosureText(values.consentDisclosure);

    return (
      !values.hosted &&
      next.length > 0 &&
      next !== tidyDisclosureText(values.defaultConsentDisclosure) &&
      next !== tidyDisclosureText(savedConsentDisclosure)
    );
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSaving) {
      return;
    }

    if (savingChangesToOwnDisclosure()) {
      setIsDisclosureNoticeOpen(true);
      return;
    }

    void saveSettings(false);
  }

  async function saveSettings(disclosureNoticeAgreed: boolean) {
    setIsDisclosureNoticeOpen(false);
    setErrors({});
    setFeedback(null);
    setIsSaving(true);

    try {
      const response = await fetch("/api/admin/settings", {
        body: JSON.stringify({
          allowedEmailDomains: values.allowedEmailDomains,
          brandColor: values.brandColor,
          consentDisclosure: values.consentDisclosure,
          consentDisclosureAcknowledged: disclosureNoticeAgreed,
          organizationName: values.organizationName,
          privacyUrl: values.privacyUrl,
          retentionDays: values.retentionDays,
          senderAddress: values.senderAddress,
          signupMode: values.signupMode,
          supportAddress: values.supportAddress,
          termsUrl: values.termsUrl,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as SettingsResponse;

      if (!response.ok || !payload?.settings) {
        setErrors(payload?.fieldErrors ?? {});
        setFeedback({
          message: payload?.error ?? GENERIC_ERROR_MESSAGE,
          tone: "error",
        });
        return;
      }

      setValues(payload.settings);
      setSavedConsentDisclosure(payload.settings.consentDisclosure);
      setEmailRevision((revision) => revision + 1);
      setFeedback({ message: "Organization settings saved.", tone: "success" });
      // The header and the accent color come from the layout around this
      // page, which only looks them up again when asked to.
      router.refresh();
    } catch {
      setFeedback({ message: GENERIC_ERROR_MESSAGE, tone: "error" });
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <section
      className="panel scroll-mt-6 p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="2"
      id="organization"
    >
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="section-eyebrow">Administrator</p>
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            Organization
          </h2>
          <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
            These settings apply to everyone who uses this site. Only you, the
            administrator, can see and change them.
          </p>
        </div>

        {feedback ? (
          <p
            className={`notice ${
              feedback.tone === "success" ? "notice-success" : "notice-danger"
            }`}
            role={feedback.tone === "error" ? "alert" : "status"}
          >
            {feedback.message}
          </p>
        ) : null}

        <form className="space-y-8" noValidate onSubmit={handleSubmit}>
          <div className="grid gap-4 sm:grid-cols-2">
            <FieldShell
              disabled={isSaving}
              error={errors.organizationName}
              helper="Shown in the header and in every email this site sends."
              label="Organization name"
              name="organization-name"
              onChange={handleChange("organizationName")}
              readOnly={false}
              value={values.organizationName}
            />
          </div>

          {/* The hosted service runs under its own name, mark and color. */}
          {!values.hosted ? (
            <BrandingPanel
              brandColor={values.brandColor}
              brandColorError={errors.brandColor}
              disabled={isSaving}
              logoUrl={values.logoUrl}
              onBrandColorChange={handleBrandColorChange}
              onLogoChange={(logoUrl) =>
                setValues((currentValues) => ({ ...currentValues, logoUrl }))
              }
            />
          ) : null}

          <fieldset className="space-y-4 border-t border-(--border) pt-8">
            <legend className="float-left mb-4 w-full text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              Who can create an account
            </legend>
            <p className="clear-both max-w-2xl text-sm leading-6 text-(--secondary)">
              {values.part11Mode
                ? "Part 11 mode is on, so this covers signers too. A Part 11 envelope goes only to someone with an account here whose identity an administrator has confirmed under People, so choose a rule that lets the people you send to create one."
                : "This is about people who send documents. People who are sent a document to sign don't need an account."}
            </p>
            <div className="space-y-3">
              {signupModeOptions.map((option) => (
                <label
                  className="flex cursor-pointer items-start gap-3 rounded-2xl bg-(--surface) px-4 py-3.5 ring-2 ring-transparent transition has-[:checked]:bg-(--accent-softer) has-[:checked]:ring-(--accent)"
                  key={option.value}
                >
                  <input
                    checked={values.signupMode === option.value}
                    className="mt-1 size-4 accent-(--accent)"
                    disabled={isSaving}
                    name="signup-mode"
                    onChange={() => handleSignupModeChange(option.value)}
                    type="radio"
                    value={option.value}
                  />
                  <span className="space-y-1">
                    <span className="block text-sm font-bold text-(--fg)">
                      {option.label}
                    </span>
                    <span className="block text-sm leading-6 text-(--secondary)">
                      {option.description}
                    </span>
                  </span>
                </label>
              ))}
            </div>
            {values.signupMode === "domains" || errors.allowedEmailDomains ? (
              <div className="max-w-xl">
                <FieldShell
                  disabled={isSaving}
                  error={errors.allowedEmailDomains}
                  helper="Separate several domains with commas."
                  label="Email domains"
                  name="allowed-email-domains"
                  onChange={handleChange("allowedEmailDomains")}
                  placeholder="yourcompany.com"
                  readOnly={false}
                  value={values.allowedEmailDomains}
                />
              </div>
            ) : null}
          </fieldset>

          <div className="space-y-5 border-t border-(--border) pt-8">
            <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
              Email addresses
            </h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <FieldShell
                disabled={isSaving || values.senderAddressFromEnv}
                error={errors.senderAddress}
                helper={
                  values.senderAddressFromEnv
                    ? "Set by the RESEND_FROM_EMAIL environment variable."
                    : "The address emails come from, at a domain you own. A subdomain such as notifications@sign.yourcompany.com keeps this site's mail apart from your everyday email."
                }
                label="Send email from"
                name="sender-address"
                onChange={handleChange("senderAddress")}
                placeholder="sign@yourcompany.com"
                readOnly={values.senderAddressFromEnv}
                type="email"
                value={values.senderAddress}
              />
              <FieldShell
                disabled={isSaving || values.supportAddressFromEnv}
                error={errors.supportAddress}
                helper={
                  values.supportAddressFromEnv
                    ? "Set by the SUPPORT_EMAIL environment variable."
                    : "Where replies and questions from signers go."
                }
                label="Support address"
                name="support-address"
                onChange={handleChange("supportAddress")}
                placeholder="help@yourcompany.com"
                readOnly={values.supportAddressFromEnv}
                type="email"
                value={values.supportAddress}
              />
            </div>
          </div>

          {!values.hosted ? (
            <div className="space-y-5 border-t border-(--border) pt-8">
              <div className="space-y-2">
                <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                  Your terms and privacy policy
                </h3>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  Optional. Links to pages on your own website, shown in the
                  footer of this site and of its emails.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell
                  disabled={isSaving}
                  error={errors.termsUrl}
                  label="Terms link"
                  name="terms-url"
                  onChange={handleChange("termsUrl")}
                  placeholder="https://yourcompany.com/terms"
                  readOnly={false}
                  value={values.termsUrl}
                />
                <FieldShell
                  disabled={isSaving}
                  error={errors.privacyUrl}
                  label="Privacy policy link"
                  name="privacy-url"
                  onChange={handleChange("privacyUrl")}
                  placeholder="https://yourcompany.com/privacy"
                  readOnly={false}
                  value={values.privacyUrl}
                />
              </div>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Without a privacy policy link, signers see{" "}
                <a
                  className="font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4"
                  href="/signer-privacy"
                  target="_blank"
                >
                  a notice built from these settings
                </a>
                . Check that it is right for your organization.
              </p>
            </div>
          ) : null}

          {!values.hosted ? (
            <div className="space-y-5 border-t border-(--border) pt-8">
              <div className="space-y-2">
                <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                  What signers agree to before signing
                </h3>
                <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                  Optional. Signers read this and tick a box to agree to use
                  electronic records and signatures before they sign. Leave it
                  empty to use the standard text, or press &ldquo;Start from the
                  standard text&rdquo; to edit it. The words each signer saw are
                  kept with their record.
                </p>
              </div>
              <Field className="gap-2 text-sm">
                <FieldLabel
                  className="text-[0.8125rem] font-semibold text-(--secondary)"
                  htmlFor="consent-disclosure"
                >
                  Disclosure text
                </FieldLabel>
                <Textarea
                  aria-describedby="consent-disclosure-description"
                  aria-invalid={errors.consentDisclosure ? true : undefined}
                  className={
                    errors.consentDisclosure
                      ? "min-h-48 border-(--danger)"
                      : "min-h-48"
                  }
                  disabled={isSaving}
                  id="consent-disclosure"
                  maxLength={6000}
                  name="consent-disclosure"
                  onChange={(event) => setConsentDisclosure(event.target.value)}
                  placeholder="Standard text"
                  value={values.consentDisclosure}
                />
                {errors.consentDisclosure ? (
                  <FieldError
                    className="text-xs font-semibold text-(--danger)"
                    id="consent-disclosure-description"
                  >
                    {errors.consentDisclosure}
                  </FieldError>
                ) : (
                  <FieldDescription
                    className="text-xs leading-5 text-(--tertiary)"
                    id="consent-disclosure-description"
                  >
                    Separate paragraphs with a blank line. Start a line with ##
                    and a space to make a heading. Write {"{sender}"} where the
                    sender&apos;s name goes and {"{contact}"} where the address
                    to write to goes.
                  </FieldDescription>
                )}
                <p className="text-xs leading-5 text-(--secondary)">
                  {CUSTOM_DISCLOSURE_LEGAL_NOTE}
                </p>
              </Field>
              <div className="flex flex-wrap gap-3">
                <ShellButton
                  disabled={isSaving}
                  onClick={() =>
                    setConsentDisclosure(values.defaultConsentDisclosure)
                  }
                  variant="secondary"
                >
                  Start from the standard text
                </ShellButton>
                {values.consentDisclosure.length > 0 ? (
                  <ShellButton
                    disabled={isSaving}
                    onClick={() => setConsentDisclosure("")}
                    variant="ghost"
                  >
                    Use the standard text
                  </ShellButton>
                ) : null}
              </div>
            </div>
          ) : null}

          <div className="space-y-5 border-t border-(--border) pt-8">
            <div className="space-y-2">
              <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
                How long to keep finished documents
              </h3>
              <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
                Optional. After this many days a completed, declined or voided
                envelope is deleted with its audit trail. Its sender is emailed
                30 days before. Leave empty to keep them until someone deletes
                them. Many records must be kept for years, so check what applies
                to you before setting this.
              </p>
            </div>
            <div className="max-w-xs">
              <FieldShell
                disabled={isSaving || values.part11Mode}
                error={errors.retentionDays}
                helper={
                  values.part11Mode
                    ? "Off while Part 11 mode is on: those records are deleted by hand only."
                    : undefined
                }
                label="Days to keep"
                name="retention-days"
                onChange={handleChange("retentionDays")}
                placeholder="Keep until deleted"
                readOnly={false}
                value={values.retentionDays}
              />
            </div>
          </div>

          <ShellButton className="w-fit" loading={isSaving} type="submit">
            {isSaving ? "Saving..." : "Save organization settings"}
          </ShellButton>
        </form>

        {isDisclosureNoticeOpen ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) {
                setIsDisclosureNoticeOpen(false);
              }
            }}
          >
            <DialogContent
              className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto sm:p-8"
              showCloseButton={false}
            >
              <DialogHeader className="space-y-3">
                <DialogTitle>{CUSTOM_DISCLOSURE_NOTICE.title}</DialogTitle>
                <DialogDescription asChild>
                  <div className="space-y-3 text-sm leading-6 text-(--secondary)">
                    {CUSTOM_DISCLOSURE_NOTICE.paragraphs.map((paragraph) => (
                      <p key={paragraph.text}>
                        {paragraph.lead ? (
                          <strong className="font-bold text-(--fg)">
                            {paragraph.lead}{" "}
                          </strong>
                        ) : null}
                        {paragraph.text}
                      </p>
                    ))}
                  </div>
                </DialogDescription>
              </DialogHeader>
              <DialogFooter className="gap-3 sm:justify-end">
                <ShellButton
                  onClick={() => setIsDisclosureNoticeOpen(false)}
                  variant="secondary"
                >
                  Cancel
                </ShellButton>
                <ShellButton onClick={() => void saveSettings(true)}>
                  {CUSTOM_DISCLOSURE_NOTICE.agree}
                </ShellButton>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        ) : null}

        <EmailSetupPanel key={emailRevision} />

        {/* The hosted service's accounts are strangers to each other, not
            one organization, so it has no list of them here. */}
        {!values.hosted ? <PeoplePanel part11Mode={values.part11Mode} /> : null}

        {!values.hosted ? (
          <>
            {" "}
            <TeamsPanel /> <TeamsPanel kind="folder" />{" "}
          </>
        ) : null}

        {!values.hosted ? (
          <SecurityPanel
            initialRequireTwoFactor={values.requireTwoFactor}
            initialSessionIdleMinutes={values.sessionIdleMinutes}
            initialSessionMaxHours={values.sessionMaxHours}
          />
        ) : null}

        {!values.hosted ? (
          <Part11Panel initialEnabled={values.part11Mode} />
        ) : null}

        {!values.hosted ? <ApiKeysPanel /> : null}

        {!values.hosted ? <WebhooksPanel /> : null}

        {!values.hosted ? <EmbeddingPanel /> : null}

        <SignerDataPanel />
      </div>
    </section>
  );
}

async function fetchEmailStatus(
  signal: AbortSignal,
): Promise<{ error: string; status: null } | { status: EmailStatus }> {
  const response = await fetch("/api/admin/email", { signal });
  const payload = (await response.json().catch(() => null)) as EmailResponse;

  if (!response.ok || !payload?.status) {
    return { error: payload?.error ?? GENERIC_ERROR_MESSAGE, status: null };
  }

  return { status: payload.status };
}

function EmailSetupPanel() {
  const [status, setStatus] = useState<EmailStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<EmailAction | null>(null);
  const [testResult, setTestResult] = useState<Feedback>(null);

  useEffect(() => {
    const controller = new AbortController();

    fetchEmailStatus(controller.signal)
      .then((result) => {
        if (result.status) {
          setLoadError(null);
          setStatus(result.status);
        } else {
          setLoadError(result.error);
        }
      })
      .catch((error: unknown) => {
        // Leaving the page cancels the request; that is not a failure.
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setLoadError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, []);

  async function runAction(action: EmailAction) {
    if (pendingAction) {
      return;
    }

    setPendingAction(action);
    setTestResult(null);

    try {
      const response = await fetch("/api/admin/email", {
        body: JSON.stringify({ action }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as EmailResponse;

      if (payload?.status) {
        setLoadError(null);
        setStatus(payload.status);
      }

      if (payload?.test) {
        setTestResult(
          payload.test.sent
            ? {
                message: `Test email sent to ${payload.test.to}. Check that inbox.`,
                tone: "success",
              }
            : { message: payload.test.message, tone: "error" },
        );
      } else if (!response.ok) {
        setLoadError(payload?.error ?? GENERIC_ERROR_MESSAGE);
      }
    } catch {
      setLoadError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  const summary = status ? describeEmailStatus(status) : null;
  const canSendTest =
    status !== null &&
    status.state !== "missing_key" &&
    status.state !== "capture" &&
    status.state !== "capture_refused";

  return (
    <div className="space-y-5 border-t border-(--border) pt-8" id="email-setup">
      <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
        Email setup
      </h3>

      {loadError ? (
        <p className="notice notice-danger" role="alert">
          {loadError}
        </p>
      ) : null}

      {!summary ? (
        loadError ? null : (
          <p className="text-sm text-(--secondary)">Checking email…</p>
        )
      ) : (
        <div
          className={`space-y-2 rounded-2xl px-5 py-4 ${
            summary.ready ? "bg-(--success-soft)" : "bg-(--surface)"
          }`}
          data-email-state={status?.state}
        >
          <p className="text-sm font-bold text-(--fg)">{summary.title}</p>
          {summary.lines.map((line) => (
            <p className="text-sm leading-6 text-(--secondary)" key={line}>
              {line}
            </p>
          ))}
          {summary.steps ? (
            <ol className="list-decimal space-y-2 pl-5 text-sm leading-6 text-(--secondary) marker:font-semibold marker:text-(--fg)">
              {summary.steps.map((step) => (
                <li key={step.text}>
                  {step.text}
                  {step.link ? (
                    <>
                      {" "}
                      <a
                        className="font-semibold text-(--accent-ink) underline underline-offset-4"
                        href={step.link.href}
                        rel="noreferrer"
                        target="_blank"
                      >
                        {step.link.label}
                      </a>
                    </>
                  ) : null}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      )}

      {status?.state === "domain_pending" ? (
        <DnsRecordsTable domain={status.domain} records={status.records} />
      ) : null}

      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {status?.state === "domain_missing" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "add_domain"}
            onClick={() => void runAction("add_domain")}
          >
            {pendingAction === "add_domain"
              ? "Adding..."
              : `Set up ${status.domain}`}
          </ShellButton>
        ) : null}
        {status?.state === "domain_pending" ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "recheck"}
            onClick={() => void runAction("recheck")}
          >
            {pendingAction === "recheck" ? "Checking..." : "Check DNS records"}
          </ShellButton>
        ) : null}
        {canSendTest ? (
          <ShellButton
            disabled={pendingAction !== null}
            loading={pendingAction === "send_test"}
            onClick={() => void runAction("send_test")}
            variant="secondary"
          >
            {pendingAction === "send_test"
              ? "Sending..."
              : "Send me a test email"}
          </ShellButton>
        ) : null}
        {status?.state === "restricted_key" ||
        status?.state === "error" ||
        status?.state === "test_sender" ? (
          <ShellButton href={RESEND_DOMAINS_URL} variant="ghost">
            Open Resend
          </ShellButton>
        ) : null}
      </div>

      {testResult ? (
        <p
          className={`notice ${
            testResult.tone === "success" ? "notice-success" : "notice-danger"
          }`}
          role={testResult.tone === "error" ? "alert" : "status"}
        >
          {testResult.message}
        </p>
      ) : null}
    </div>
  );
}

type EmailStep = {
  link?: { href: string; label: string };
  text: string;
};

function describeEmailStatus(status: EmailStatus): {
  lines: string[];
  ready: boolean;
  steps?: EmailStep[];
  title: string;
} {
  switch (status.state) {
    case "capture":
      return {
        lines: [
          "This is a development setup. Emails are saved to a folder on this machine instead of being sent.",
        ],
        ready: true,
        title: "Emails are being captured, not sent",
      };
    case "capture_refused":
      return status.onVercel
        ? {
            lines: [
              "EMAIL_DRIVER=capture drops every email and cannot be used in production, so this site refuses to send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                text: "In this project on Vercel, open Settings, then Environment Variables, and remove EMAIL_DRIVER (or set it to resend).",
              },
              {
                link: {
                  href: RESEND_MARKETPLACE_URL,
                  label: "Resend on the Vercel Marketplace",
                },
                text: "Connect Resend and check that RESEND_API_KEY is listed for Production.",
              },
              {
                text: "Open Deployments, open the ••• menu on the latest Production deployment and choose Redeploy, then reload this page.",
              },
            ],
            title: "Email cannot be sent with EMAIL_DRIVER=capture",
          }
        : {
            lines: [
              "EMAIL_DRIVER=capture drops every email and cannot be used in production, so this site refuses to send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                text: "Remove EMAIL_DRIVER=capture from the environment variables where this site runs (or set EMAIL_DRIVER=resend).",
              },
              {
                link: {
                  href: "https://resend.com/api-keys",
                  label: "Resend API keys",
                },
                text: "Configure a delivery provider by setting RESEND_API_KEY if it is not set already.",
              },
              { text: "Restart the app, then reload this page." },
            ],
            title: "Email cannot be sent with EMAIL_DRIVER=capture",
          };
    case "missing_key":
      return status.onVercel
        ? {
            lines: [
              "This site has no Resend API key, so it cannot send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                link: {
                  href: RESEND_MARKETPLACE_URL,
                  label: "Resend on the Vercel Marketplace",
                },
                text: "Open Resend on the Vercel Marketplace. Choose Install (or Connect Project if your team already has Resend) and connect it to this project.",
              },
              {
                text: "In this project on Vercel, open Settings, then Environment Variables, and check that RESEND_API_KEY is listed for Production.",
              },
              {
                text: "Open Deployments, open the ••• menu on the latest Production deployment and choose Redeploy. Environment variables only reach deployments made after they were added, so a site deployed before Resend was connected still has no key until it is redeployed.",
              },
              {
                text: "When the new deployment is ready, reload this page.",
              },
            ],
            title: "Email is not connected",
          }
        : {
            lines: [
              "This site has no Resend API key, so it cannot send anything: no sign-up confirmations and no signing invitations.",
            ],
            ready: false,
            steps: [
              {
                link: {
                  href: "https://resend.com/api-keys",
                  label: "Resend API keys",
                },
                text: "Create an API key in Resend with full access, so this page can add your domain and check its DNS records.",
              },
              {
                text: "Set it as the RESEND_API_KEY environment variable where this site runs.",
              },
              { text: "Restart the app, then reload this page." },
            ],
            title: "Email is not connected",
          };
    case "test_sender":
      return {
        lines: [
          `Emails are going out from Resend's shared test address (${status.senderAddress}). Resend only delivers those to the owner of the Resend account, so signers and new users will not receive anything yet.`,
          'Enter an address at your own domain in "Send email from" above and save. The DNS records to add will appear here.',
        ],
        ready: false,
        title: "Email only reaches you so far",
      };
    case "domain_missing":
      return {
        lines: [
          `${status.domain} has not been added to your Resend account yet. Set it up here to get the DNS records that prove you own it.`,
        ],
        ready: false,
        title: `${status.domain} needs to be set up`,
      };
    case "domain_pending":
      return {
        lines: [
          `Add these records where ${status.domain}'s DNS is managed, then check them. DNS changes can take a few minutes to be seen, and sometimes longer.`,
          ...(status.mayAlreadySend
            ? [
                "Resend has verified part of this domain, so sending may already work. Send yourself a test email to find out. If it arrives, email is working.",
              ]
            : []),
        ],
        ready: false,
        title: `Waiting for ${status.domain}'s DNS records`,
      };
    case "restricted_key":
      return {
        lines: [
          `This site's Resend key is only allowed to send email, so it cannot check ${status.domain} from here. Open Resend to add the domain and see its DNS records.`,
          "When that is done, send yourself a test email. If it arrives, email is working.",
        ],
        ready: false,
        title: "Finish the domain in Resend",
      };
    case "ready":
      return {
        lines: [
          `Emails are sent from ${status.senderAddress}, and ${status.domain} is verified.`,
        ],
        ready: true,
        title: "Email is working",
      };
    case "error":
      return {
        lines: [
          `Resend could not be asked about this site's email: ${status.message}`,
        ],
        ready: false,
        title: "Email could not be checked",
      };
  }
}

function DnsRecordsTable({
  domain,
  records,
}: {
  domain: string;
  records: readonly EmailDnsRecord[];
}) {
  if (records.length === 0) {
    return (
      <p className="text-sm leading-6 text-(--secondary)">
        Resend did not list any records for {domain}. Open Resend to see them.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-(--border)">
      <table className="w-full min-w-[640px] border-collapse text-left text-sm">
        <caption className="sr-only">DNS records to add for {domain}</caption>
        <thead>
          <tr className="border-b border-(--border) bg-(--surface) text-xs text-(--tertiary)">
            <th className="px-4 py-3 font-semibold" scope="col">
              Type
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Name
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Value
            </th>
            <th className="px-4 py-3 font-semibold" scope="col">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr
              className="border-b border-(--border) align-top last:border-b-0"
              key={`${record.type}-${record.name}-${record.value}`}
            >
              <td className="px-4 py-3 font-semibold text-(--fg)">
                {record.type}
                {record.priority !== null ? (
                  <span className="block text-xs font-normal text-(--tertiary)">
                    Priority {record.priority}
                  </span>
                ) : null}
              </td>
              <td className="px-4 py-3 font-mono text-[0.8rem] break-all text-(--fg)">
                {record.name}
              </td>
              <td className="px-4 py-3 font-mono text-[0.8rem] break-all text-(--fg)">
                {record.value}
              </td>
              <td className="px-4 py-3 text-(--secondary)">
                {record.status === "verified" ? "Found" : "Not found yet"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
