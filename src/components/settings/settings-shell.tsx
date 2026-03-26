"use client";

import { useState, type ChangeEvent, type FormEvent } from "react";

import { FieldShell, ShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const CLOSURE_CONFIRMATION_PHRASE = "close my account";
const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type SettingsShellProps = {
  initialProfile?: ProfileValues;
};

type FeedbackTone = "error" | "success";

type FeedbackMessage = {
  message: string;
  tone: FeedbackTone;
} | null;

type ProfileValues = {
  email: string;
  fullName: string;
};

type PasswordValues = {
  currentPassword: string;
  newPassword: string;
};

type ProfileErrors = Partial<Record<keyof ProfileValues, string>>;
type PasswordErrors = Partial<Record<keyof PasswordValues, string>>;

type PendingAction = "closure" | "password" | "profile" | "reset" | null;

type ApiErrorPayload = {
  error?:
    | string
    | {
        message?: string;
      };
  fieldErrors?: Partial<Record<string, string>>;
  message?: string;
} | null;

const defaultProfileValues: ProfileValues = {
  email: "",
  fullName: "",
};

const defaultPasswordValues: PasswordValues = {
  currentPassword: "",
  newPassword: "",
};

function trimProfileValues(values: ProfileValues): ProfileValues {
  return {
    email: values.email.trim(),
    fullName: values.fullName.trim(),
  };
}

function validateProfileValues(values: ProfileValues): ProfileErrors {
  const errors: ProfileErrors = {};

  if (values.fullName.length === 0) {
    errors.fullName = "Enter your full name";
  }

  if (values.email.length === 0 || !values.email.includes("@")) {
    errors.email = "Enter a valid email address";
  }

  return errors;
}

function validatePasswordValues(values: PasswordValues): PasswordErrors {
  const errors: PasswordErrors = {};

  if (values.currentPassword.length === 0) {
    errors.currentPassword = "Enter your current password";
  }

  if (values.newPassword.trim().length < 15) {
    errors.newPassword = "Password must be at least 15 characters";
  }

  return errors;
}

async function readApiPayload(response: Response): Promise<ApiErrorPayload> {
  return (await response.json().catch(() => null)) as ApiErrorPayload;
}

function extractApiErrorMessage(payload: ApiErrorPayload): string {
  if (!payload) {
    return GENERIC_ERROR_MESSAGE;
  }

  if (typeof payload.error === "string" && payload.error.trim()) {
    return payload.error;
  }

  if (
    payload.error &&
    typeof payload.error === "object" &&
    typeof payload.error.message === "string" &&
    payload.error.message.trim()
  ) {
    return payload.error.message;
  }

  if (typeof payload.message === "string" && payload.message.trim()) {
    return payload.message;
  }

  return GENERIC_ERROR_MESSAGE;
}

function isDuplicateEmailMessage(message: string) {
  const normalizedMessage = message.toLowerCase();

  return (
    normalizedMessage.includes("already registered") ||
    normalizedMessage.includes("already in use")
  );
}

function isInvalidPasswordMessage(message: string) {
  return message.toLowerCase().includes("invalid password");
}

function isPasswordTooShortMessage(message: string) {
  return message.toLowerCase().includes("password too short");
}

function isCompromisedPasswordMessage(message: string) {
  return message.toLowerCase().includes("compromised");
}

function isNoOpEmailChangeMessage(message: string) {
  const normalizedMessage = message.toLowerCase();

  return (
    normalizedMessage.includes("email is the same") ||
    normalizedMessage.includes("already verified")
  );
}

export function SettingsShell({
  initialProfile = defaultProfileValues,
}: SettingsShellProps) {
  const [profileValues, setProfileValues] = useState(initialProfile);
  const [savedProfileValues, setSavedProfileValues] = useState(initialProfile);
  const [profileErrors, setProfileErrors] = useState<ProfileErrors>({});
  const [passwordValues, setPasswordValues] = useState(defaultPasswordValues);
  const [passwordErrors, setPasswordErrors] = useState<PasswordErrors>({});
  const [feedback, setFeedback] = useState<FeedbackMessage>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [isClosureDialogOpen, setIsClosureDialogOpen] = useState(false);
  const [closureConfirmation, setClosureConfirmation] = useState("");

  const isBusy = pendingAction !== null;
  const isClosureConfirmationValid =
    closureConfirmation.trim().toLowerCase() === CLOSURE_CONFIRMATION_PHRASE;

  function handleProfileChange(field: keyof ProfileValues) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setProfileValues((currentValues) => ({
        ...currentValues,
        [field]: nextValue,
      }));
      setProfileErrors((currentErrors) => ({
        ...currentErrors,
        [field]: undefined,
      }));
      setFeedback(null);
    };
  }

  function handlePasswordChange(field: keyof PasswordValues) {
    return (event: ChangeEvent<HTMLInputElement>) => {
      const nextValue = event.target.value;

      setPasswordValues((currentValues) => ({
        ...currentValues,
        [field]: nextValue,
      }));
      setPasswordErrors((currentErrors) => ({
        ...currentErrors,
        [field]: undefined,
      }));
      setFeedback(null);
    };
  }

  async function handleProfileSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isBusy) {
      return;
    }

    const trimmedValues = trimProfileValues(profileValues);
    const nextErrors = validateProfileValues(trimmedValues);

    if (Object.keys(nextErrors).length > 0) {
      setProfileValues(trimmedValues);
      setProfileErrors(nextErrors);
      setFeedback(null);
      return;
    }

    setProfileValues(trimmedValues);
    setProfileErrors({});
    setFeedback(null);
    setPendingAction("profile");

    try {
      const nameChanged =
        trimmedValues.fullName !== savedProfileValues.fullName;
      const emailChanged =
        trimmedValues.email.trim().toLowerCase() !==
        savedProfileValues.email.trim().toLowerCase();
      let nextSavedProfile = savedProfileValues;

      if (nameChanged) {
        const response = await fetch("/api/account/profile", {
          body: JSON.stringify({
            email: savedProfileValues.email,
            fullName: trimmedValues.fullName,
          }),
          headers: {
            "content-type": "application/json",
          },
          method: "PATCH",
        });
        const payload = await readApiPayload(response);

        if (!response.ok) {
          const fieldErrors = payload?.fieldErrors ?? {};
          const errorMessage = extractApiErrorMessage(payload);

          setProfileErrors({
            email:
              typeof fieldErrors.email === "string"
                ? fieldErrors.email
                : isDuplicateEmailMessage(errorMessage)
                  ? "This email is already registered"
                  : undefined,
            fullName:
              typeof fieldErrors.fullName === "string"
                ? fieldErrors.fullName
                : undefined,
          });
          setFeedback({
            message:
              typeof fieldErrors.email === "string" ||
              typeof fieldErrors.fullName === "string"
                ? "Please correct the highlighted fields."
                : errorMessage,
            tone: "error",
          });
          return;
        }

        nextSavedProfile = {
          email: savedProfileValues.email,
          fullName: trimmedValues.fullName,
        };
        setSavedProfileValues(nextSavedProfile);
      }

      if (emailChanged) {
        const response = await fetch("/api/auth/change-email", {
          body: JSON.stringify({
            callbackURL: `${window.location.origin}/settings`,
            newEmail: trimmedValues.email,
          }),
          headers: {
            "content-type": "application/json",
          },
          method: "POST",
        });
        const payload = await readApiPayload(response);

        if (!response.ok) {
          const errorMessage = extractApiErrorMessage(payload);

          setProfileErrors({
            email: isDuplicateEmailMessage(errorMessage)
              ? "This email is already registered"
              : isNoOpEmailChangeMessage(errorMessage)
                ? "Enter a different email address"
                : undefined,
            fullName: undefined,
          });
          setProfileValues({
            email: trimmedValues.email,
            fullName: nextSavedProfile.fullName,
          });
          setFeedback({
            message:
              isDuplicateEmailMessage(errorMessage) ||
              isNoOpEmailChangeMessage(errorMessage)
                ? "Please correct the highlighted fields."
                : errorMessage,
            tone: "error",
          });
          return;
        }

        setProfileValues(nextSavedProfile);
        setProfileErrors({});
        setFeedback({
          message: nameChanged
            ? "Profile updated. If the email change can proceed, you'll receive the next steps by email."
            : "If the email change can proceed, you'll receive the next steps by email.",
          tone: "success",
        });
        return;
      }

      setProfileValues(nextSavedProfile);
      setProfileErrors({});
      setFeedback({
        message: "Profile updated.",
        tone: "success",
      });
    } catch {
      setFeedback({
        message: GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handlePasswordSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (isBusy) {
      return;
    }

    const nextErrors = validatePasswordValues(passwordValues);

    if (Object.keys(nextErrors).length > 0) {
      setPasswordErrors(nextErrors);
      setFeedback(null);
      return;
    }

    setPasswordErrors({});
    setFeedback(null);
    setPendingAction("password");

    try {
      const response = await fetch("/api/auth/change-password", {
        body: JSON.stringify({
          ...passwordValues,
          revokeOtherSessions: true,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = await readApiPayload(response);

      if (!response.ok) {
        const errorMessage = extractApiErrorMessage(payload);

        setPasswordErrors({
          currentPassword: isInvalidPasswordMessage(errorMessage)
            ? "Current password is incorrect"
            : undefined,
          newPassword: isPasswordTooShortMessage(errorMessage)
            ? "Password must be at least 15 characters"
            : isCompromisedPasswordMessage(errorMessage)
              ? "Choose a password that hasn't appeared in a breach"
              : undefined,
        });
        setFeedback({
          message:
            isInvalidPasswordMessage(errorMessage) ||
            isPasswordTooShortMessage(errorMessage) ||
            isCompromisedPasswordMessage(errorMessage)
              ? "Please correct the highlighted fields."
              : errorMessage,
          tone: "error",
        });
        return;
      }

      setPasswordValues(defaultPasswordValues);
      setPasswordErrors({});
      setFeedback({
        message: "Password updated.",
        tone: "success",
      });
    } catch {
      setFeedback({
        message: GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }

  async function handleResetPasswordLink() {
    if (isBusy) {
      return;
    }

    const trimmedProfileValues = trimProfileValues(profileValues);
    const nextErrors = validateProfileValues(trimmedProfileValues);

    if (nextErrors.email) {
      setProfileValues(trimmedProfileValues);
      setProfileErrors((currentErrors) => ({
        ...currentErrors,
        email: nextErrors.email,
      }));
      setFeedback(null);
      return;
    }

    setProfileValues(trimmedProfileValues);
    setProfileErrors((currentErrors) => ({
      ...currentErrors,
      email: undefined,
    }));
    setFeedback(null);
    setPendingAction("reset");

    try {
      const response = await fetch("/api/auth/request-password-reset", {
        body: JSON.stringify({
          email: trimmedProfileValues.email,
          redirectTo: `${window.location.origin}/login`,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = await readApiPayload(response);

      if (!response.ok) {
        setFeedback({
          message: extractApiErrorMessage(payload),
          tone: "error",
        });
        return;
      }

      setFeedback({
        message: "Password reset link sent.",
        tone: "success",
      });
    } catch {
      setFeedback({
        message: GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }

  function openClosureDialog() {
    if (isBusy) {
      return;
    }

    setClosureConfirmation("");
    setFeedback(null);
    setIsClosureDialogOpen(true);
  }

  function closeClosureDialog() {
    if (pendingAction === "closure") {
      return;
    }

    setClosureConfirmation("");
    setIsClosureDialogOpen(false);
  }

  async function handleClosureSubmit() {
    if (pendingAction === "closure" || !isClosureConfirmationValid) {
      return;
    }

    setFeedback(null);
    setPendingAction("closure");

    try {
      const response = await fetch("/api/account/closure-request", {
        body: JSON.stringify({
          confirmation: CLOSURE_CONFIRMATION_PHRASE,
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      });
      const payload = await readApiPayload(response);

      if (!response.ok) {
        setFeedback({
          message: extractApiErrorMessage(payload),
          tone: "error",
        });
        return;
      }

      setClosureConfirmation("");
      setIsClosureDialogOpen(false);
      setFeedback({
        message:
          "We've received your request. Download any documents you want to keep within 30 days.",
        tone: "success",
      });
    } catch {
      setFeedback({
        message: GENERIC_ERROR_MESSAGE,
        tone: "error",
      });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className="space-y-8">
      <PageHeader
        description="Manage your sender profile, password, and account lifecycle."
        eyebrow="Account"
        title="Settings"
      />

      {feedback ? <SettingsFeedback feedback={feedback} /> : null}

      <section
        className="editorial-panel p-6 sm:p-8"
        data-animate="enter"
        data-animate-delay="1"
      >
        <div className="space-y-8">
          <div className="space-y-5">
            <SectionHeading title="Profile" />

            <form className="space-y-5" onSubmit={handleProfileSubmit}>
              <div className="grid gap-4 sm:grid-cols-2">
                <FieldShell
                  disabled={isBusy}
                  error={profileErrors.fullName}
                  label="Full name"
                  name="fullName"
                  onChange={handleProfileChange("fullName")}
                  readOnly={false}
                  value={profileValues.fullName}
                />
                <FieldShell
                  disabled={isBusy}
                  error={profileErrors.email}
                  label="Email"
                  name="email"
                  onChange={handleProfileChange("email")}
                  readOnly={false}
                  type="email"
                  value={profileValues.email}
                />
              </div>
              <p className="text-sm leading-6 text-muted-foreground">
                Email changes are verified through your current inbox first,
                then the new inbox.
              </p>

              <ShellButton
                className="w-fit"
                loading={pendingAction === "profile"}
                type="submit"
              >
                {pendingAction === "profile" ? "Saving..." : "Save changes"}
              </ShellButton>
            </form>
          </div>

          <div className="border-t border-(--border) pt-8">
            <div className="space-y-5">
              <SectionHeading title="Password" />

              <form className="space-y-5" onSubmit={handlePasswordSubmit}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FieldShell
                    disabled={isBusy}
                    error={passwordErrors.currentPassword}
                    label="Current password"
                    name="currentPassword"
                    onChange={handlePasswordChange("currentPassword")}
                    placeholder="••••••••••"
                    readOnly={false}
                    type="password"
                    value={passwordValues.currentPassword}
                  />
                  <FieldShell
                    disabled={isBusy}
                    error={passwordErrors.newPassword}
                    helper="Must be at least 15 characters"
                    label="New password"
                    name="newPassword"
                    onChange={handlePasswordChange("newPassword")}
                    placeholder="•••••••••••••••"
                    readOnly={false}
                    type="password"
                    value={passwordValues.newPassword}
                  />
                </div>

                <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                  <ShellButton
                    className="w-fit"
                    loading={pendingAction === "password"}
                    type="submit"
                  >
                    {pendingAction === "password"
                      ? "Updating..."
                      : "Update password"}
                  </ShellButton>
                  <ShellButton
                    disabled={isBusy}
                    loading={pendingAction === "reset"}
                    onClick={handleResetPasswordLink}
                    variant="secondary"
                  >
                    {pendingAction === "reset"
                      ? "Sending..."
                      : "Email me a reset link"}
                  </ShellButton>
                </div>
              </form>
            </div>
          </div>

          <div className="border-t border-(--border) pt-8">
            <div className="space-y-5">
              <SectionHeading title="Danger zone" />
              <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
                Before closing your account, download any documents you want to
                keep. After closure, SignuDoc may provide a 30-day export window
                and then delete stored document files and related envelope
                records.
              </p>
              <ShellButton
                className="w-fit"
                disabled={isBusy}
                onClick={openClosureDialog}
                variant="secondary"
              >
                Request account closure
              </ShellButton>
            </div>
          </div>
        </div>
      </section>

      {isClosureDialogOpen ? (
        <AccountClosureDialog
          confirmationValue={closureConfirmation}
          isReady={isClosureConfirmationValid}
          isSubmitting={pendingAction === "closure"}
          onCancel={closeClosureDialog}
          onChange={setClosureConfirmation}
          onConfirm={handleClosureSubmit}
        />
      ) : null}
    </div>
  );
}

function SectionHeading({ title }: Readonly<{ title: string }>) {
  return (
    <h2 className="text-xl font-bold tracking-[-0.03em] text-(--fg)">
      {title}
    </h2>
  );
}

function SettingsFeedback({
  feedback,
}: Readonly<{
  feedback: Exclude<FeedbackMessage, null>;
}>) {
  const toneClasses =
    feedback.tone === "success"
      ? "border-[rgba(5,150,105,0.18)] bg-[rgba(5,150,105,0.05)] text-chart-4"
      : "border-[rgba(180,35,53,0.18)] bg-[rgba(180,35,53,0.04)] text-(--accent)";

  return (
    <section
      className={`border px-5 py-4 ${toneClasses}`}
      role={feedback.tone === "error" ? "alert" : "status"}
    >
      <p className="text-sm font-semibold">{feedback.message}</p>
    </section>
  );
}

type AccountClosureDialogProps = {
  confirmationValue: string;
  isReady: boolean;
  isSubmitting: boolean;
  onCancel: () => void;
  onChange: (value: string) => void;
  onConfirm: () => void;
};

function AccountClosureDialog({
  confirmationValue,
  isReady,
  isSubmitting,
  onCancel,
  onChange,
  onConfirm,
}: AccountClosureDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !isSubmitting) {
          onCancel();
        }
      }}
    >
      <DialogContent
        className="max-w-lg rounded-none border-(--border) sm:p-8"
        showCloseButton={false}
      >
        <div className="space-y-5">
          <DialogHeader className="space-y-3">
            <DialogTitle className="text-xl tracking-[-0.03em]">
              Request account closure?
            </DialogTitle>
            <DialogDescription className="text-sm leading-6 text-muted-foreground">
              Before closing your account, download any documents you want to
              keep. After closure, SignuDoc may provide a 30-day export window
              and then delete stored document files and related envelope
              records.
            </DialogDescription>
          </DialogHeader>

          <Field className="gap-2 text-sm">
            <FieldLabel
              className="font-semibold text-(--fg)"
              htmlFor="close-account-confirmation"
            >
              Type &quot;close my account&quot; to confirm:
            </FieldLabel>
            <Input
              aria-label='Type "close my account" to confirm:'
              disabled={isSubmitting}
              id="close-account-confirmation"
              onChange={(event) => onChange(event.target.value)}
              type="text"
              value={confirmationValue}
            />
          </Field>

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <ShellButton
              disabled={isSubmitting}
              onClick={onCancel}
              variant="secondary"
            >
              Cancel
            </ShellButton>
            <ShellButton
              disabled={!isReady}
              loading={isSubmitting}
              onClick={onConfirm}
            >
              {isSubmitting ? "Requesting..." : "Request closure"}
            </ShellButton>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
