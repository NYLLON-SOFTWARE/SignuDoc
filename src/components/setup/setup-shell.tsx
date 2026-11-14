"use client";

import { useRouter } from "next/navigation";
import {
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";

import { Brand } from "@/components/layout/brand";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/cn";
import {
  buildSenderAddress,
  DEFAULT_SENDER_LOCAL_PART,
  DEFAULT_SENDING_SUBDOMAIN,
  joinSendingDomain,
  normalizeSubdomain,
  readResendEmailDomain,
  suggestSendingRootDomain,
  type SenderAddressParts,
} from "@/lib/sending-domain";
import type { SetupFieldName, SetupView } from "@/lib/setup";
import { getEmailDomain, suggestSignupPolicy } from "@/lib/signup-policy";

export type SetupShellView =
  | Exclude<SetupView, { view: "complete" }>
  | { view: "complete" }
  | { view: "no_database" };

type SetupShellProps = {
  hosted: boolean;
  onVercel: boolean;
  /** RESEND_EMAIL_DOMAIN, set by the Resend integration on Vercel. */
  resendDomain: string | null;
  /** The host this site answers on, used to guess the sending domain. */
  siteHost: string | null;
  view: SetupShellView;
};

type SetupValues = Record<SetupFieldName, string>;
type SetupErrors = Partial<Record<SetupFieldName, string>>;

type SetupResponse = {
  error?: string;
  fieldErrors?: SetupErrors;
  redirectTo?: string;
} | null;

const GENERIC_ERROR_MESSAGE = "Setup could not be completed. Please try again.";

const emptyValues: SetupValues = {
  email: "",
  fullName: "",
  organizationName: "",
  password: "",
  senderAddress: "",
  setupToken: "",
  supportAddress: "",
};

export function SetupShell({
  hosted,
  onVercel,
  resendDomain,
  siteHost,
  view,
}: SetupShellProps) {
  return (
    <div className="flex min-h-screen flex-col">
      <header>
        <div className="page-width flex items-center justify-between gap-4 py-4">
          <Brand href="/setup" />
          <span className="pill pill-accent">Setup</span>
        </div>
      </header>

      <main className="page-width flex flex-1 items-start justify-center py-8 sm:py-14">
        <div className="flex w-full justify-center" data-animate="enter">
          <section className="panel w-full max-w-[520px] p-8 sm:p-10">
            <SetupContent
              hosted={hosted}
              onVercel={onVercel}
              resendDomain={resendDomain}
              siteHost={siteHost}
              view={view}
            />
          </section>
        </div>
      </main>

      <PublicLegalFooter />
    </div>
  );
}

function SetupContent({
  hosted,
  onVercel,
  resendDomain,
  siteHost,
  view,
}: SetupShellProps) {
  if (view.view === "no_database") {
    return (
      <SetupNotice title="Connect a database">
        <p>
          This site does not have a database yet, so there is nowhere to keep
          accounts or documents.
        </p>
        {onVercel ? (
          <p>
            In Vercel, open this project&apos;s Storage tab, add a Neon Postgres
            database and connect it to the project. Then deploy again and reload
            this page.
          </p>
        ) : (
          <p>
            Set the DATABASE_URL environment variable to a Postgres database,
            run <code>npm run db:migrate</code>, restart the app and reload this
            page.
          </p>
        )}
      </SetupNotice>
    );
  }

  if (view.view === "unmigrated") {
    return (
      <SetupNotice title="The database is not ready">
        <p>
          The database is connected, but its tables have not been created or are
          from an older version.
        </p>
        {onVercel ? (
          <p>
            Deploy this project again. Tables are created during a production
            deployment. Then reload this page.
          </p>
        ) : (
          <p>
            Run <code>npm run db:migrate</code>, restart the app and reload this
            page.
          </p>
        )}
      </SetupNotice>
    );
  }

  if (view.view === "claim") {
    if (!view.tokenConfigured) {
      return (
        <SetupNotice title="Choose an administrator">
          <p>
            This site already has accounts but no administrator. To choose one,
            set the SETUP_TOKEN environment variable to a secret of your own,
            deploy again, and come back to this page.
          </p>
          <p>
            The token is asked for here, so that only someone who controls the
            deployment can become the administrator.
          </p>
        </SetupNotice>
      );
    }

    if (!view.signedInEmail) {
      return (
        <SetupNotice title="Choose an administrator">
          <p>
            This site already has accounts but no administrator. Sign in with
            the account that should become the administrator, then open this
            page again.
          </p>
          <ShellButton className="w-full" href="/login" variant="primary">
            Go to log in
          </ShellButton>
        </SetupNotice>
      );
    }
  }

  if (view.view === "complete") {
    return null;
  }

  return (
    <SetupForm
      hosted={hosted}
      resendDomain={resendDomain}
      siteHost={siteHost}
      view={view}
    />
  );
}

function SetupNotice({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h1 className="text-[clamp(1.875rem,4.5vw,2.375rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)">
          {title}
        </h1>
      </div>
      <div className="space-y-4 text-sm leading-6 text-muted-foreground [&_code]:rounded-md [&_code]:bg-(--surface) [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8125rem] [&_code]:text-(--fg)">
        {children}
      </div>
    </div>
  );
}

function describeSignupStart(email: string, hosted: boolean): string | null {
  if (hosted) {
    return null;
  }

  if (!getEmailDomain(email)) {
    return null;
  }

  const policy = suggestSignupPolicy(email);

  if (policy.signupMode === "domains") {
    return `Other people with an @${policy.allowedEmailDomains[0]} address will be able to create accounts. You can change this in Settings.`;
  }

  return "Only you will have an account to begin with. You can let other people in from Settings.";
}

type SenderErrors = Partial<Record<keyof SenderAddressParts, string>>;

function SetupForm({
  hosted,
  resendDomain,
  siteHost,
  view,
}: {
  hosted: boolean;
  resendDomain: string | null;
  siteHost: string | null;
  view: Extract<SetupShellView, { view: "claim" | "create" }>;
}) {
  const [values, setValues] = useState<SetupValues>(emptyValues);
  // The domain the Resend integration set up comes first. Without one,
  // until the administrator types a domain of their own, it follows what
  // setup can tell from the site's address and the emails typed above.
  const [integrationSender] = useState(() =>
    readResendEmailDomain(resendDomain),
  );
  const [sender, setSender] = useState<SenderAddressParts>(
    () =>
      integrationSender ?? {
        localPart: DEFAULT_SENDER_LOCAL_PART,
        rootDomain: "",
        subdomain: DEFAULT_SENDING_SUBDOMAIN,
      },
  );
  const [rootDomainEdited, setRootDomainEdited] = useState(
    integrationSender !== null,
  );
  const [senderErrors, setSenderErrors] = useState<SenderErrors>({});
  const [errors, setErrors] = useState<SetupErrors>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const router = useRouter();
  const isCreate = view.view === "create";
  const requiresToken = isCreate ? view.requiresToken : true;
  const asksForSender = isCreate && !view.senderAddressFromEnv;
  const asksForSupport = view.asksForSupportAddress;
  const suggestedRootDomain = asksForSender
    ? suggestSendingRootDomain({
        emails: [values.email, values.supportAddress],
        siteHost,
      })
    : null;
  const senderParts: SenderAddressParts = {
    ...sender,
    rootDomain: rootDomainEdited
      ? sender.rootDomain
      : (suggestedRootDomain ?? ""),
  };

  function handleSenderChange(field: keyof SenderAddressParts) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      if (field === "rootDomain") {
        setRootDomainEdited(true);
      }

      setSender((current) => ({ ...current, [field]: nextValue }));
      setSenderErrors((current) => ({ ...current, [field]: undefined }));
      setErrors((current) => ({ ...current, senderAddress: undefined }));
      setBannerMessage(null);
    };
  }

  async function handleSwitchAccount() {
    if (isSwitchingAccount) {
      return;
    }

    setIsSwitchingAccount(true);

    // The login page sends anyone who is signed in on to the dashboard, so
    // the current session has to end before it will show its form.
    await authClient.signOut().catch(() => undefined);
    router.push("/login");
  }

  function handleChange(field: SetupFieldName) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({ ...currentValues, [field]: nextValue }));
      setErrors((currentErrors) => ({ ...currentErrors, [field]: undefined }));
      setBannerMessage(null);
    };
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    setBannerMessage(null);
    setErrors({});
    setSenderErrors({});

    const builtSender = asksForSender
      ? buildSenderAddress(senderParts)
      : { address: null, error: null };

    if (builtSender.error) {
      setSenderErrors({ [builtSender.error.field]: builtSender.error.message });
      setBannerMessage("Check the address this site sends email from.");
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch("/api/setup", {
        body: JSON.stringify({
          organizationName: values.organizationName,
          setupToken: requiresToken ? values.setupToken : undefined,
          supportAddress: asksForSupport ? values.supportAddress : undefined,
          ...(isCreate
            ? {
                email: values.email,
                fullName: values.fullName,
                password: values.password,
                senderAddress: builtSender.address ?? undefined,
              }
            : {}),
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response
        .json()
        .catch(() => null)) as SetupResponse;

      if (!response.ok) {
        setErrors(payload?.fieldErrors ?? {});
        setBannerMessage(payload?.error ?? GENERIC_ERROR_MESSAGE);
        setIsSubmitting(false);
        return;
      }

      // A full page load, so the app starts again with the new session and
      // the organization's name.
      window.location.assign(payload?.redirectTo ?? "/dashboard");
    } catch {
      setBannerMessage(GENERIC_ERROR_MESSAGE);
      setIsSubmitting(false);
    }
  }

  const signupStart = isCreate
    ? describeSignupStart(values.email, hosted)
    : null;

  return (
    <div className="space-y-7">
      <div className="space-y-2">
        <h1 className="text-[clamp(1.875rem,4.5vw,2.375rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)">
          {isCreate ? "Set up your site" : "Choose an administrator"}
        </h1>
        <p className="pt-1 text-sm leading-6 text-muted-foreground">
          {isCreate
            ? "You are the first person here. The account you create now is the administrator: it can change these settings later and decide who else may sign up."
            : `You are signed in as ${view.signedInEmail ?? ""}. This account will become the administrator, who decides who may sign up and how email is sent.`}
        </p>
      </div>

      {bannerMessage ? (
        <p className="notice notice-danger" role="alert">
          {bannerMessage}
        </p>
      ) : null}

      <form className="space-y-5" noValidate onSubmit={handleSubmit}>
        <FieldShell
          autoComplete="organization"
          disabled={isSubmitting}
          error={errors.organizationName}
          helper="Shown in the header and in every email this site sends."
          label="Organization name"
          name="setup-organization-name"
          onChange={handleChange("organizationName")}
          placeholder="Acme Corp"
          readOnly={false}
          value={values.organizationName}
        />

        {asksForSupport ? (
          <FieldShell
            autoComplete="off"
            disabled={isSubmitting}
            error={errors.supportAddress}
            helper="Signers and people with an account are told to write here for help, and replies to this site's emails come here. You can change it in Settings."
            ignorePasswordManagers
            label="Support email"
            name="setup-support-address"
            onChange={handleChange("supportAddress")}
            placeholder="help@acmecorp.com"
            readOnly={false}
            type="email"
            value={values.supportAddress}
          />
        ) : null}

        {isCreate ? (
          <>
            <FieldShell
              autoComplete="name"
              disabled={isSubmitting}
              error={errors.fullName}
              label="Your name"
              name="setup-full-name"
              onChange={handleChange("fullName")}
              placeholder="Jane Smith"
              readOnly={false}
              value={values.fullName}
            />
            <FieldShell
              // "username" tells password managers this is the login the
              // new password belongs to, so they save the two together.
              autoComplete="username"
              disabled={isSubmitting}
              error={errors.email}
              helper={signupStart ?? undefined}
              label="Your email"
              name="setup-email"
              onChange={handleChange("email")}
              placeholder="jane@acmecorp.com"
              readOnly={false}
              type="email"
              value={values.email}
            />
            <FieldShell
              autoComplete="new-password"
              disabled={isSubmitting}
              error={errors.password}
              helper="At least 15 characters. Let your password manager make one."
              label="Password"
              maxLength={128}
              minLength={15}
              name="setup-password"
              passwordRules="minlength: 20; maxlength: 64; required: lower; required: upper; required: digit; allowed: [-_.!@#$%^&*];"
              onChange={handleChange("password")}
              placeholder="Enter a password"
              readOnly={false}
              type="password"
              value={values.password}
            />
          </>
        ) : null}

        {asksForSender ? (
          <SenderFields
            disabled={isSubmitting}
            errors={senderErrors}
            onChange={handleSenderChange}
            parts={senderParts}
            serverError={errors.senderAddress}
            source={
              integrationSender &&
              sender.rootDomain === integrationSender.rootDomain
                ? "integration"
                : !rootDomainEdited && suggestedRootDomain !== null
                  ? "guess"
                  : null
            }
          />
        ) : null}

        {requiresToken ? (
          <FieldShell
            autoComplete="off"
            disabled={isSubmitting}
            error={errors.setupToken}
            helper="The value of the SETUP_TOKEN environment variable on this deployment."
            // Not a password of the account being made, so a password
            // manager should neither fill nor save it.
            ignorePasswordManagers
            label="Setup token"
            name="setup-token"
            onChange={handleChange("setupToken")}
            readOnly={false}
            type="password"
            value={values.setupToken}
          />
        ) : null}

        <ShellButton
          className="w-full"
          disabled={isSubmitting}
          loading={isSubmitting}
          type="submit"
          variant="primary"
        >
          {isSubmitting
            ? "Setting up..."
            : isCreate
              ? "Finish setup"
              : "Become the administrator"}
        </ShellButton>
      </form>

      {!isCreate ? (
        <p className="border-t border-(--border) pt-5 text-sm text-(--secondary)">
          Not the right account?{" "}
          <button
            className="cursor-pointer font-bold text-(--accent-ink) underline-offset-4 hover:underline disabled:cursor-default disabled:opacity-60"
            disabled={isSwitchingAccount}
            onClick={handleSwitchAccount}
            type="button"
          >
            Log in as someone else
          </button>
        </p>
      ) : null}
    </div>
  );
}

const senderLabelClass = "text-[0.8125rem] font-semibold text-(--secondary)";
const senderHelperClass = "text-xs leading-5 text-(--tertiary)";
const senderErrorClass = "text-xs font-semibold text-(--danger)";

// The address this site sends from, asked for as its parts: the
// organization's domain (filled in when setup can tell it), a subdomain in
// front of it ("sign" unless changed) and the name before the @. Together
// they read as notifications@sign.acmecorp.com.
function SenderFields({
  disabled,
  errors,
  onChange,
  parts,
  serverError,
  source,
}: {
  disabled: boolean;
  errors: SenderErrors;
  onChange: (
    field: keyof SenderAddressParts,
  ) => (event: ChangeEvent<HTMLInputElement>) => void;
  parts: SenderAddressParts;
  serverError?: string;
  /** Where the domain shown came from, if setup filled it in. */
  source: "guess" | "integration" | null;
}) {
  const built = buildSenderAddress(parts);
  const rootDomain = parts.rootDomain.trim().toLowerCase();
  // The same tidying the saved address gets, so the preview matches it.
  const subdomain = normalizeSubdomain(parts.subdomain) ?? "";
  const sendingDomain = rootDomain
    ? joinSendingDomain(rootDomain, subdomain)
    : null;
  const rootError = errors.rootDomain ?? serverError;
  const passwordManagerIgnore = {
    "data-1p-ignore": "true",
    "data-lpignore": "true",
  };

  return (
    <fieldset className="space-y-4 rounded-2xl border border-(--border) p-4 sm:p-5">
      <legend className="px-1 text-sm font-bold text-(--fg)">
        Send email from
      </legend>
      <p className={senderHelperClass}>
        Optional. Email is sent through Resend from a domain your organization
        owns. Leave the domain empty to decide later in Settings.
      </p>

      <div className="space-y-2 text-sm">
        <label className={senderLabelClass} htmlFor="setup-sender-domain">
          Your domain
        </label>
        <Input
          aria-describedby="setup-sender-domain-description"
          aria-invalid={rootError ? true : undefined}
          autoComplete="off"
          className={rootError ? "border-(--danger)" : undefined}
          disabled={disabled}
          id="setup-sender-domain"
          inputMode="url"
          name="setup-sender-domain"
          onChange={onChange("rootDomain")}
          placeholder="acmecorp.com"
          spellCheck={false}
          value={parts.rootDomain}
          {...passwordManagerIgnore}
        />
        <p
          className={rootError ? senderErrorClass : senderHelperClass}
          id="setup-sender-domain-description"
        >
          {rootError ??
            (source === "integration"
              ? "The domain the Resend integration was set up with on Vercel."
              : source === "guess"
                ? "Filled in from this site's address and the emails above. Change it if your organization uses another domain."
                : "The domain your organization's email uses, such as acmecorp.com.")}
        </p>
      </div>

      <div className="space-y-2 text-sm">
        <label className={senderLabelClass} htmlFor="setup-sender-subdomain">
          Subdomain
        </label>
        <div className="flex items-center gap-2">
          <Input
            aria-describedby="setup-sender-subdomain-description"
            aria-invalid={errors.subdomain ? true : undefined}
            autoComplete="off"
            className={cn(
              "w-40 flex-none",
              errors.subdomain ? "border-(--danger)" : "",
            )}
            disabled={disabled}
            id="setup-sender-subdomain"
            name="setup-sender-subdomain"
            onChange={onChange("subdomain")}
            placeholder="none"
            spellCheck={false}
            value={parts.subdomain}
            {...passwordManagerIgnore}
          />
          <span className="min-w-0 truncate text-sm text-(--secondary)">
            .{rootDomain || "acmecorp.com"}
          </span>
        </div>
        <p
          className={errors.subdomain ? senderErrorClass : senderHelperClass}
          id="setup-sender-subdomain-description"
        >
          {errors.subdomain ??
            (subdomain
              ? `Recommended. Mail comes from ${sendingDomain ?? `${subdomain}.acmecorp.com`}, so its DNS records and sending reputation stay apart from your everyday email. Clear it to send from ${rootDomain || "the domain"} itself.`
              : `Mail will come from ${rootDomain || "the domain"} itself. A subdomain such as ${DEFAULT_SENDING_SUBDOMAIN} keeps it apart from your everyday email.`)}
        </p>
      </div>

      <div className="space-y-2 text-sm">
        <label className={senderLabelClass} htmlFor="setup-sender-local-part">
          Address
        </label>
        <div className="flex items-center gap-2">
          <Input
            aria-describedby="setup-sender-local-part-description"
            aria-invalid={errors.localPart ? true : undefined}
            autoComplete="off"
            className={cn(
              "w-40 flex-none",
              errors.localPart ? "border-(--danger)" : "",
            )}
            disabled={disabled}
            id="setup-sender-local-part"
            name="setup-sender-local-part"
            onChange={onChange("localPart")}
            spellCheck={false}
            value={parts.localPart}
            {...passwordManagerIgnore}
          />
          <span className="min-w-0 truncate text-sm text-(--secondary)">
            @{sendingDomain ?? "acmecorp.com"}
          </span>
        </div>
        <p
          className={errors.localPart ? senderErrorClass : senderHelperClass}
          id="setup-sender-local-part-description"
        >
          {errors.localPart ??
            "Nobody needs to read this mailbox: replies go to the support email."}
        </p>
      </div>

      {built.address ? (
        <p className="rounded-xl bg-(--surface) px-4 py-3 text-xs leading-5 text-(--secondary)">
          Emails will come from{" "}
          <strong className="font-semibold text-(--fg)">{built.address}</strong>
          . If Resend is connected, setup adds {built.sendingDomain} to it, and
          the next screen lists the DNS records to add where your domain is
          managed.
        </p>
      ) : null}
    </fieldset>
  );
}
