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
import { authClient } from "@/lib/auth/client";
import type { SetupFieldName, SetupView } from "@/lib/setup";
import { getEmailDomain, suggestSignupPolicy } from "@/lib/signup-policy";

export type SetupShellView =
  | Exclude<SetupView, { view: "complete" }>
  | { view: "complete" }
  | { view: "no_database" };

type SetupShellProps = {
  hosted: boolean;
  onVercel: boolean;
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
};

export function SetupShell({ hosted, onVercel, view }: SetupShellProps) {
  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-(--border) bg-white">
        <div className="editorial-shell flex items-center justify-between gap-4 px-0 py-5">
          <Brand href="/setup" />
          <p className="editorial-meta">Setup</p>
        </div>
      </header>

      <main className="editorial-shell flex flex-1 items-start justify-center px-0 py-12 sm:py-16">
        <div className="flex w-full justify-center" data-animate="enter">
          <section className="editorial-panel w-full max-w-[520px] p-8 sm:p-10">
            <SetupContent hosted={hosted} onVercel={onVercel} view={view} />
          </section>
        </div>
      </main>

      <PublicLegalFooter />
    </div>
  );
}

function SetupContent({ hosted, onVercel, view }: SetupShellProps) {
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

  return <SetupForm hosted={hosted} view={view} />;
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
        <p className="section-eyebrow">Setup</p>
        <h1 className="text-[clamp(2rem,4.6vw,2.7rem)] font-extrabold leading-[1.04] tracking-[-0.045em] text-black">
          {title}
        </h1>
      </div>
      <div className="space-y-4 text-sm leading-6 text-muted-foreground [&_code]:[font-family:var(--font-mono)] [&_code]:text-[0.82rem] [&_code]:text-(--fg)">
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

function SetupForm({
  hosted,
  view,
}: {
  hosted: boolean;
  view: Extract<SetupShellView, { view: "claim" | "create" }>;
}) {
  const [values, setValues] = useState<SetupValues>(emptyValues);
  const [errors, setErrors] = useState<SetupErrors>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSwitchingAccount, setIsSwitchingAccount] = useState(false);
  const router = useRouter();
  const isCreate = view.view === "create";
  const requiresToken = isCreate ? view.requiresToken : true;
  const asksForSender = isCreate && !view.senderAddressFromEnv;

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
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/setup", {
        body: JSON.stringify({
          organizationName: values.organizationName,
          setupToken: requiresToken ? values.setupToken : undefined,
          ...(isCreate
            ? {
                email: values.email,
                fullName: values.fullName,
                password: values.password,
                senderAddress: asksForSender ? values.senderAddress : undefined,
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
        <p className="section-eyebrow">Setup</p>
        <h1 className="text-[clamp(2rem,4.6vw,2.7rem)] font-extrabold leading-[1.04] tracking-[-0.045em] text-black">
          {isCreate ? "Set up your site" : "Choose an administrator"}
        </h1>
        <p className="pt-1 text-sm leading-6 text-muted-foreground">
          {isCreate
            ? "You are the first person here. The account you create now is the administrator: it can change these settings later and decide who else may sign up."
            : `You are signed in as ${view.signedInEmail ?? ""}. This account will become the administrator, who decides who may sign up and how email is sent.`}
        </p>
      </div>

      {bannerMessage ? (
        <p
          className="rounded-[22px] border border-[rgba(180,35,53,0.16)] bg-[rgba(180,35,53,0.06)] px-4 py-3 text-sm font-medium text-(--accent)"
          role="alert"
        >
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
              autoComplete="email"
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
              helper="Must be at least 15 characters"
              label="Password"
              name="setup-password"
              onChange={handleChange("password")}
              placeholder="Enter a password"
              readOnly={false}
              type="password"
              value={values.password}
            />
          </>
        ) : null}

        {asksForSender ? (
          <FieldShell
            autoComplete="off"
            disabled={isSubmitting}
            error={errors.senderAddress}
            helper="Optional. An address at a domain you own, such as sign@yourcompany.com. The next screen shows the DNS records that let this site send from it. Leave it empty to decide later."
            label="Send email from"
            name="setup-sender-address"
            onChange={handleChange("senderAddress")}
            placeholder="sign@acmecorp.com"
            readOnly={false}
            type="email"
            value={values.senderAddress}
          />
        ) : null}

        {requiresToken ? (
          <FieldShell
            autoComplete="off"
            disabled={isSubmitting}
            error={errors.setupToken}
            helper="The value of the SETUP_TOKEN environment variable on this deployment."
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
        <p className="border-t border-(--border) pt-5 text-sm text-muted-foreground">
          Not the right account?{" "}
          <button
            className="cursor-pointer font-semibold text-(--fg) transition hover:text-(--accent) disabled:cursor-default disabled:opacity-60"
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
