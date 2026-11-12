"use client";

import Link from "next/link";
import {
  useState,
  type ChangeEvent,
  type ChangeEventHandler,
  type FormEvent,
} from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { authClient } from "@/lib/auth/client";
import { signUpSchema } from "@/lib/schemas/auth";

const defaultSuccessMessage = "Check your email to verify your sender account.";

type AuthErrorLike = {
  code?: string;
  message?: string;
};

// Codes the server answers with when this install's sign-up rule turns an
// address away. The message that comes with them says what the rule is.
const SIGNUP_RULE_ERROR_CODES = new Set([
  "setup_required",
  "signup_closed",
  "signup_domain_not_allowed",
]);

type SignupShellProps = {
  /** False when this install is not taking new accounts at all. */
  signupAvailable?: boolean;
  /** One sentence on who can create an account, or null when anyone can. */
  signupRule?: string | null;
};

type SignupFormValues = {
  email: string;
  fullName: string;
  password: string;
};

type SignupFormErrors = Partial<Record<keyof SignupFormValues, string>>;

function createSignupFormValues(): SignupFormValues {
  return {
    email: "",
    fullName: "",
    password: "",
  };
}

function trimFormValues(values: SignupFormValues): SignupFormValues {
  return {
    email: values.email.trim(),
    fullName: values.fullName.trim(),
    password: values.password,
  };
}

function normalizeAuthErrorMessage(
  error: AuthErrorLike | null | undefined,
): string {
  return error?.message?.trim().toLowerCase() ?? "";
}

type SignupFormCardProps = {
  bannerMessage: string | null;
  errors: SignupFormErrors;
  formLocked: boolean;
  isResendingVerification?: boolean;
  isSubmitting: boolean;
  onEmailChange: ChangeEventHandler<HTMLInputElement>;
  onFullNameChange: ChangeEventHandler<HTMLInputElement>;
  onPasswordChange: ChangeEventHandler<HTMLInputElement>;
  onResendVerification?: () => void | Promise<void>;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  showSuccess: boolean;
  signupRule: string | null;
  successMessage: string | null;
  values: SignupFormValues;
};

function SignupFormCard({
  bannerMessage,
  errors,
  formLocked,
  isResendingVerification = false,
  isSubmitting,
  onEmailChange,
  onFullNameChange,
  onPasswordChange,
  onResendVerification,
  onSubmit,
  showSuccess,
  signupRule,
  successMessage,
  values,
}: SignupFormCardProps) {
  return (
    <section className="editorial-panel w-full max-w-[460px] p-8 sm:p-10">
      <div className="space-y-7">
        <div className="space-y-2">
          <p className="section-eyebrow">Create account</p>
          <h1 className="text-[clamp(2.2rem,5vw,3rem)] font-extrabold leading-[1.02] tracking-[-0.045em] text-black">
            Create your account
          </h1>
          {signupRule ? (
            <p className="pt-1 text-sm leading-6 text-muted-foreground">
              {signupRule}
            </p>
          ) : null}
        </div>

        {bannerMessage ? (
          <p
            className="rounded-[22px] border border-[rgba(180,35,53,0.16)] bg-[rgba(180,35,53,0.06)] px-4 py-3 text-sm font-medium text-(--accent)"
            role="alert"
          >
            {bannerMessage}
          </p>
        ) : null}

        {showSuccess ? (
          <div
            aria-live="polite"
            className="rounded-[24px] border border-[rgba(5,150,105,0.18)] bg-[rgba(5,150,105,0.08)] px-5 py-4"
          >
            <p className="text-sm font-semibold text-(--fg)">
              {successMessage ?? defaultSuccessMessage}
            </p>
          </div>
        ) : null}

        <form className="space-y-5" noValidate onSubmit={onSubmit}>
          <FieldShell
            autoComplete="name"
            disabled={formLocked}
            error={errors.fullName}
            label="Full name"
            name="signup-full-name"
            onChange={onFullNameChange}
            placeholder="Jane Smith"
            readOnly={formLocked}
            value={values.fullName}
          />
          <FieldShell
            autoComplete="email"
            disabled={formLocked}
            error={errors.email}
            label="Email"
            name="signup-email"
            onChange={onEmailChange}
            placeholder="jane@acmecorp.com"
            readOnly={formLocked}
            type="email"
            value={values.email}
          />
          <FieldShell
            autoComplete="new-password"
            disabled={formLocked}
            error={errors.password}
            helper="Must be at least 15 characters"
            label="Password"
            name="signup-password"
            onChange={onPasswordChange}
            placeholder="Enter a password"
            readOnly={formLocked}
            type="password"
            value={values.password}
          />

          {showSuccess ? (
            <div className="flex flex-col gap-3">
              <ShellButton className="w-full" href="/login" variant="primary">
                Go to log in
              </ShellButton>
              {onResendVerification ? (
                <ShellButton
                  className="w-full"
                  disabled={formLocked}
                  loading={isResendingVerification}
                  onClick={onResendVerification}
                  type="button"
                  variant="secondary"
                >
                  {isResendingVerification
                    ? "Sending..."
                    : "Resend verification email"}
                </ShellButton>
              ) : null}
            </div>
          ) : (
            <ShellButton
              className="w-full"
              disabled={formLocked}
              loading={isSubmitting}
              type="submit"
              variant="primary"
            >
              {isSubmitting ? "Creating account..." : "Sign up"}
            </ShellButton>
          )}
        </form>

        <div className="border-t border-(--border) pt-5 text-sm text-muted-foreground">
          Already have an account?{" "}
          <Link
            className="font-semibold text-(--fg) transition hover:text-(--accent)"
            href="/login"
          >
            Log in
          </Link>
        </div>
      </div>
    </section>
  );
}

export function SignupShell({
  signupAvailable = true,
  signupRule = null,
}: SignupShellProps) {
  if (!signupAvailable) {
    return <SignupClosedCard />;
  }

  return <LiveSignupShell signupRule={signupRule} />;
}

function SignupClosedCard() {
  return (
    <section className="editorial-panel w-full max-w-[460px] p-8 sm:p-10">
      <div className="space-y-7">
        <div className="space-y-2">
          <p className="section-eyebrow">Create account</p>
          <h1 className="text-[clamp(2.2rem,5vw,3rem)] font-extrabold leading-[1.02] tracking-[-0.045em] text-black">
            Sign-up is closed
          </h1>
          <p className="pt-1 text-sm leading-6 text-muted-foreground">
            New accounts are not being accepted on this site. If you were sent
            a document to sign, use the link in that email. You do not need an
            account.
          </p>
        </div>
        <ShellButton className="w-full" href="/login" variant="primary">
          Go to log in
        </ShellButton>
      </div>
    </section>
  );
}

function LiveSignupShell({ signupRule }: { signupRule: string | null }) {
  const [values, setValues] = useState<SignupFormValues>(
    createSignupFormValues(),
  );
  const [errors, setErrors] = useState<SignupFormErrors>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const [successEmail, setSuccessEmail] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  function handleChange(field: keyof SignupFormValues) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setValues((currentValues) => ({
        ...currentValues,
        [field]: nextValue,
      }));

      setErrors((currentErrors) => ({
        ...currentErrors,
        [field]: undefined,
      }));
      setBannerMessage(null);
      setShowSuccess(false);
      setSuccessMessage(null);
    };
  }

  async function handleResendVerification() {
    if (!successEmail || isResendingVerification) {
      return;
    }

    setBannerMessage(null);
    setIsResendingVerification(true);

    try {
      const response = await fetch("/api/auth/send-verification-email", {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/dashboard`,
          email: successEmail,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });

      if (!response.ok) {
        setBannerMessage("We couldn't resend the verification email.");
        return;
      }

      setSuccessMessage("Verification email sent. Check your inbox.");
    } catch {
      setBannerMessage("We couldn't resend the verification email.");
    } finally {
      setIsResendingVerification(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting || isResendingVerification) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const trimmedValues = trimFormValues({
      email: String(formData.get("signup-email") ?? values.email),
      fullName: String(formData.get("signup-full-name") ?? values.fullName),
      password: String(formData.get("signup-password") ?? values.password),
    });
    const validationResult = signUpSchema.safeParse(trimmedValues);

    if (!validationResult.success) {
      const nextErrors: SignupFormErrors = {};

      for (const issue of validationResult.error.issues) {
        const field = issue.path[0];

        if (field === "email") {
          nextErrors.email = "Enter a valid email address";
        }

        if (field === "fullName") {
          nextErrors.fullName = "Enter your full name";
        }

        if (field === "password") {
          nextErrors.password = "Password must be at least 15 characters";
        }
      }

      setValues(trimmedValues);
      setErrors(nextErrors);
      setBannerMessage(null);
      setShowSuccess(false);
      setSuccessMessage(null);
      return;
    }

    setValues(validationResult.data);
    setErrors({});
    setBannerMessage(null);
    setShowSuccess(false);
    setSuccessMessage(null);
    setIsSubmitting(true);

    const result = await authClient.signUp.email({
      callbackURL: `${window.location.origin}/dashboard`,
      email: validationResult.data.email,
      name: validationResult.data.fullName,
      password: validationResult.data.password,
    });

    if (result.error) {
      const normalizedErrorMessage = normalizeAuthErrorMessage(result.error);

      if (SIGNUP_RULE_ERROR_CODES.has(result.error.code ?? "")) {
        setBannerMessage(
          result.error.message ?? "New accounts are not being accepted.",
        );
      } else if (
        normalizedErrorMessage.includes("user already exists") ||
        normalizedErrorMessage.includes("use another email")
      ) {
        setErrors({
          email: "This email is already registered",
        });
      } else if (normalizedErrorMessage.includes("password too short")) {
        setErrors({
          password: "Password must be at least 15 characters",
        });
      } else if (normalizedErrorMessage.includes("compromised")) {
        setErrors({
          password: "Choose a password that hasn't appeared in a breach",
        });
      } else {
        setBannerMessage("Something went wrong. Please try again.");
      }

      setIsSubmitting(false);
      return;
    }

    setSuccessEmail(validationResult.data.email);
    setSuccessMessage(defaultSuccessMessage);
    setShowSuccess(true);
    setIsSubmitting(false);
  }

  return (
    <SignupFormCard
      bannerMessage={bannerMessage}
      errors={errors}
      formLocked={isSubmitting || isResendingVerification}
      isResendingVerification={isResendingVerification}
      isSubmitting={isSubmitting}
      onEmailChange={handleChange("email")}
      onFullNameChange={handleChange("fullName")}
      onPasswordChange={handleChange("password")}
      onResendVerification={handleResendVerification}
      onSubmit={handleSubmit}
      showSuccess={showSuccess}
      signupRule={signupRule}
      successMessage={successMessage}
      values={values}
    />
  );
}
