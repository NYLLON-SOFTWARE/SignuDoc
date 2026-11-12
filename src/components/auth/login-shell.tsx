"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ChangeEvent, type FormEvent } from "react";

import { useBranding } from "@/components/layout/branding-provider";
import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { authClient } from "@/lib/auth/client";
import { forgotPasswordSchema, loginSchema } from "@/lib/schemas/auth";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const verificationRequiredMessage =
  "Verify your email before logging in. Check your inbox for a fresh link.";

type AuthErrorLike = {
  message?: string;
};

type LoginFormValues = {
  email: string;
  password: string;
};

type ForgotPasswordFormValues = {
  email: string;
};

type LoginFormErrors = Partial<Record<keyof LoginFormValues, string>>;
type ForgotPasswordFormErrors = Partial<
  Record<keyof ForgotPasswordFormValues, string>
>;

type LoginShellProps = {
  resetError?: string | null;
  resetToken?: string | null;
};

type ForgotPasswordModel = {
  bannerMessage: string | null;
  errors: ForgotPasswordFormErrors;
  isOpen: boolean;
  isSubmitting: boolean;
  successMessage: string | null;
  values: ForgotPasswordFormValues;
};

function createLoginFormValues(): LoginFormValues {
  return {
    email: "",
    password: "",
  };
}

function createForgotPasswordValues(
  email: string,
  trim = false,
): ForgotPasswordFormValues {
  return {
    email: trim ? email.trim() : email,
  };
}

function createForgotPasswordModel(
  email: string,
  overrides: Partial<Omit<ForgotPasswordModel, "values">> = {},
): ForgotPasswordModel {
  return {
    bannerMessage: null,
    errors: {},
    isOpen: false,
    isSubmitting: false,
    successMessage: null,
    values: createForgotPasswordValues(email),
    ...overrides,
  };
}

function trimLoginValues(values: LoginFormValues): LoginFormValues {
  return {
    email: values.email.trim(),
    password: values.password,
  };
}

function trimForgotPasswordValues(
  values: ForgotPasswordFormValues,
): ForgotPasswordFormValues {
  return createForgotPasswordValues(values.email, true);
}

function normalizeAuthErrorMessage(
  error: AuthErrorLike | null | undefined,
): string {
  return error?.message?.trim().toLowerCase() ?? "";
}

export function LoginShell({
  resetError = null,
  resetToken = null,
}: LoginShellProps) {
  return <LiveLoginShell resetError={resetError} resetToken={resetToken} />;
}

function LiveLoginShell({
  resetError = null,
  resetToken = null,
}: LoginShellProps) {
  const router = useRouter();
  const { signupAvailable } = useBranding();
  const [values, setValues] = useState<LoginFormValues>(
    createLoginFormValues(),
  );
  const [errors, setErrors] = useState<LoginFormErrors>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(
    resetError === "INVALID_TOKEN"
      ? "This reset link is invalid or has expired."
      : null,
  );
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [forgotPassword, setForgotPassword] = useState<ForgotPasswordModel>(
    createForgotPasswordModel(""),
  );
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [showResendVerification, setShowResendVerification] = useState(false);

  function handleChange(field: keyof LoginFormValues) {
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
      setShowResendVerification(false);
    };
  }

  function openForgotPasswordModal() {
    setForgotPassword(
      createForgotPasswordModel(values.email.trim(), { isOpen: true }),
    );
  }

  function closeForgotPasswordModal() {
    if (forgotPassword.isSubmitting) {
      return;
    }

    setForgotPassword(createForgotPasswordModel(values.email.trim()));
  }

  function handleForgotPasswordChange(event: ChangeEvent<HTMLInputElement>) {
    const nextValue = event.target.value;

    setForgotPassword((currentForgotPassword) => ({
      ...currentForgotPassword,
      bannerMessage: null,
      errors: {
        ...currentForgotPassword.errors,
        email: undefined,
      },
      successMessage: null,
      values: createForgotPasswordValues(nextValue),
    }));
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const trimmedValues = trimLoginValues({
      email: String(formData.get("login-email") ?? values.email),
      password: String(formData.get("login-password") ?? values.password),
    });
    const validationResult = loginSchema.safeParse(trimmedValues);

    if (!validationResult.success) {
      const nextErrors: LoginFormErrors = {};

      for (const issue of validationResult.error.issues) {
        const field = issue.path[0];

        if (field === "email") {
          nextErrors.email = "Enter a valid email address";
        }

        if (field === "password") {
          nextErrors.password = "Enter your password";
        }
      }

      setValues(trimmedValues);
      setErrors(nextErrors);
      setBannerMessage(null);
      return;
    }

    setValues(validationResult.data);
    setErrors({});
    setBannerMessage(null);
    setShowResendVerification(false);
    setIsSubmitting(true);

    const result = await authClient.signIn.email({
      email: validationResult.data.email,
      password: validationResult.data.password,
    });

    if (result.error) {
      const normalizedErrorMessage = normalizeAuthErrorMessage(result.error);

      if (normalizedErrorMessage.includes("email not verified")) {
        setBannerMessage(verificationRequiredMessage);
        setShowResendVerification(true);
      } else {
        setBannerMessage(
          normalizedErrorMessage.includes("invalid email or password")
            ? "Invalid email or password. Please try again."
            : "Something went wrong. Please try again.",
        );
      }
      setIsSubmitting(false);
      return;
    }

    router.replace("/dashboard");
  }

  async function handleForgotPasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (forgotPassword.isSubmitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const trimmedValues = trimForgotPasswordValues({
      email: String(
        formData.get("forgot-password-email") ?? forgotPassword.values.email,
      ),
    });
    const validationResult = forgotPasswordSchema.safeParse(trimmedValues);

    if (!validationResult.success) {
      setForgotPassword((currentForgotPassword) => ({
        ...currentForgotPassword,
        bannerMessage: null,
        errors: {
          email: "Enter a valid email address",
        },
        successMessage: null,
        values: trimmedValues,
      }));
      return;
    }

    setForgotPassword((currentForgotPassword) => ({
      ...currentForgotPassword,
      bannerMessage: null,
      errors: {},
      isSubmitting: true,
      successMessage: null,
      values: validationResult.data,
    }));

    const result = await authClient.requestPasswordReset({
      email: validationResult.data.email,
      redirectTo: `${window.location.origin}/login`,
    });

    setForgotPassword((currentForgotPassword) => ({
      ...currentForgotPassword,
      bannerMessage: result.error
        ? "We couldn't send the reset link. Please try again."
        : null,
      errors: {},
      isSubmitting: false,
      successMessage: result.error
        ? null
        : "Check your email for a reset link.",
    }));
  }

  async function handleResendVerification() {
    const email = values.email.trim();

    if (!email || isResendingVerification) {
      return;
    }

    setIsResendingVerification(true);

    try {
      const response = await fetch("/api/auth/send-verification-email", {
        body: JSON.stringify({
          callbackURL: `${window.location.origin}/dashboard`,
          email,
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

      setBannerMessage("Verification email sent. Check your inbox.");
    } catch {
      setBannerMessage("We couldn't resend the verification email.");
    } finally {
      setIsResendingVerification(false);
    }
  }

  if (resetToken) {
    return <ResetPasswordCard resetToken={resetToken} />;
  }

  const formLocked = isSubmitting;
  const forgotPasswordLocked = forgotPassword.isSubmitting;

  return (
    <>
      <section className="editorial-panel w-full max-w-[460px] p-8 sm:p-10">
        <div className="space-y-7">
          <div className="space-y-2">
            <p className="section-eyebrow">Log in</p>
            <h1 className="text-[clamp(2.2rem,5vw,3rem)] font-extrabold leading-[1.02] tracking-[-0.045em] text-black">
              Welcome back
            </h1>
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
              autoComplete="email"
              disabled={formLocked}
              error={errors.email}
              label="Email"
              name="login-email"
              onChange={handleChange("email")}
              placeholder="jane@acmecorp.com"
              readOnly={formLocked}
              type="email"
              value={values.email}
            />
            <FieldShell
              autoComplete="current-password"
              disabled={formLocked}
              error={errors.password}
              label="Password"
              name="login-password"
              onChange={handleChange("password")}
              readOnly={formLocked}
              type="password"
              value={values.password}
            />
            <ShellButton
              className="w-full"
              disabled={formLocked}
              loading={isSubmitting}
              type="submit"
            >
              {isSubmitting ? "Logging in..." : "Log in"}
            </ShellButton>
            {showResendVerification ? (
              <ShellButton
                className="w-full"
                disabled={formLocked}
                loading={isResendingVerification}
                onClick={handleResendVerification}
                type="button"
                variant="secondary"
              >
                {isResendingVerification
                  ? "Sending..."
                  : "Resend verification email"}
              </ShellButton>
            ) : null}
          </form>

          <div className="flex flex-col gap-3 border-t border-(--border) pt-5 text-sm text-muted-foreground">
            <button
              className="w-fit p-0 text-left font-medium text-(--fg) transition hover:text-(--accent)"
              onClick={openForgotPasswordModal}
              type="button"
            >
              Forgot your password?
            </button>
            {signupAvailable ? (
              <p>
                Don&apos;t have an account?{" "}
                <Link
                  className="font-semibold text-(--fg) transition hover:text-(--accent)"
                  href="/signup"
                >
                  Sign up
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      </section>

      <ForgotPasswordDialog
        bannerMessage={forgotPassword.bannerMessage}
        email={forgotPassword.values.email}
        emailError={forgotPassword.errors.email}
        isOpen={forgotPassword.isOpen}
        isSubmitting={forgotPasswordLocked}
        onClose={closeForgotPasswordModal}
        onEmailChange={handleForgotPasswordChange}
        onSubmit={handleForgotPasswordSubmit}
        successMessage={forgotPassword.successMessage}
      />
    </>
  );
}

type ForgotPasswordDialogProps = {
  bannerMessage: string | null;
  email: string;
  emailError?: string;
  isOpen: boolean;
  isSubmitting: boolean;
  onClose: () => void;
  onEmailChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void | Promise<void>;
  successMessage: string | null;
};

function ForgotPasswordDialog({
  bannerMessage,
  email,
  emailError,
  isOpen,
  isSubmitting,
  onClose,
  onEmailChange,
  onSubmit,
  successMessage,
}: ForgotPasswordDialogProps) {
  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!open && !isSubmitting) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="max-w-[560px] rounded-none border-(--border) sm:p-8"
        showCloseButton={false}
      >
        <div className="space-y-6">
          <DialogHeader className="space-y-3">
            <DialogTitle>Reset your password</DialogTitle>
            <DialogDescription className="max-w-[40ch]">
              Enter the email address associated with your account and
              we&apos;ll send you a reset link.
            </DialogDescription>
          </DialogHeader>

          {bannerMessage ? (
            <p
              className="rounded-[22px] border border-[rgba(180,35,53,0.16)] bg-[rgba(180,35,53,0.06)] px-4 py-3 text-sm font-medium text-(--accent)"
              role="alert"
            >
              {bannerMessage}
            </p>
          ) : null}

          {successMessage ? (
            <p
              className="rounded-[22px] border border-[rgba(5,150,105,0.18)] bg-[rgba(5,150,105,0.08)] px-4 py-3 text-sm font-medium text-(--fg)"
              role="status"
            >
              {successMessage}
            </p>
          ) : null}

          <form className="space-y-6" noValidate onSubmit={onSubmit}>
            <FieldShell
              autoComplete="email"
              disabled={isSubmitting}
              error={emailError}
              label="Email"
              name="forgot-password-email"
              onChange={onEmailChange}
              placeholder="jane@acmecorp.com"
              readOnly={isSubmitting}
              type="email"
              value={email}
            />

            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <ShellButton
                disabled={isSubmitting}
                onClick={onClose}
                type="button"
                variant="secondary"
              >
                Cancel
              </ShellButton>
              <ShellButton
                disabled={isSubmitting}
                loading={isSubmitting}
                type="submit"
              >
                {isSubmitting ? "Sending..." : "Send reset link"}
              </ShellButton>
            </div>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordCard({ resetToken }: { resetToken: string }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    const formData = new FormData(event.currentTarget);
    const trimmedPassword = String(
      formData.get("reset-password") ?? password,
    ).trim();

    if (trimmedPassword.length < 15) {
      setError("Password must be at least 15 characters");
      setSuccessMessage(null);
      return;
    }

    setPassword(trimmedPassword);
    setError(null);
    setSuccessMessage(null);
    setIsSubmitting(true);

    const result = await authClient.resetPassword({
      newPassword: trimmedPassword,
      token: resetToken,
    });

    if (result.error) {
      const normalizedErrorMessage = normalizeAuthErrorMessage(result.error);

      setError(
        normalizedErrorMessage.includes("invalid token")
          ? "This reset link is invalid or has expired."
          : normalizedErrorMessage.includes("password too short")
            ? "Password must be at least 15 characters"
            : normalizedErrorMessage.includes("compromised")
              ? "Choose a password that hasn't appeared in a breach"
              : "Something went wrong. Please try again.",
      );
      setIsSubmitting(false);
      return;
    }

    setSuccessMessage(
      "Your password has been reset. Log in with your new password.",
    );
    setIsSubmitting(false);
  }

  const formLocked = isSubmitting;

  return (
    <section className="editorial-panel w-full max-w-[440px] p-8 sm:p-10">
      <div className="space-y-8">
        <div className="space-y-2">
          <p className="section-eyebrow">Reset password</p>
          <h1 className="text-[clamp(2.1rem,5vw,2.8rem)] font-extrabold leading-[1.02] tracking-[-0.045em] text-black">
            Create a new password
          </h1>
        </div>

        {error ? (
          <p
            className="rounded-[22px] border border-[rgba(255,0,51,0.16)] bg-[rgba(255,0,51,0.06)] px-4 py-3 text-sm font-medium text-(--accent)"
            role="alert"
          >
            {error}
          </p>
        ) : null}

        {successMessage ? (
          <p
            className="rounded-[22px] border border-[rgba(5,150,105,0.18)] bg-[rgba(5,150,105,0.08)] px-4 py-3 text-sm font-medium text-(--fg)"
            role="status"
          >
            {successMessage}
          </p>
        ) : null}

        <form className="space-y-5" noValidate onSubmit={handleSubmit}>
          <FieldShell
            autoComplete="new-password"
            disabled={formLocked}
            error={error ?? undefined}
            helper="Must be at least 15 characters"
            label="New password"
            name="reset-password"
            onChange={(event) => {
              setPassword(event.target.value);
              setError(null);
              setSuccessMessage(null);
            }}
            readOnly={formLocked}
            type="password"
            value={password}
          />
          <ShellButton
            className="w-full"
            disabled={formLocked}
            loading={isSubmitting}
            type="submit"
          >
            {isSubmitting ? "Updating password..." : "Update password"}
          </ShellButton>
        </form>
      </div>
    </section>
  );
}
