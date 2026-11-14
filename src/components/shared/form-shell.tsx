import Link from "next/link";
import { useId, type ChangeEventHandler, type ReactNode } from "react";

import { cn } from "@/lib/cn";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type FieldShellProps = {
  autoComplete?: string;
  disabled?: boolean;
  error?: string;
  helper?: string;
  label: string;
  name?: string;
  onChange?: ChangeEventHandler<HTMLInputElement>;
  placeholder?: string;
  readOnly?: boolean;
  type?: "text" | "email" | "password";
  value?: string;
  /**
   * Keeps password managers from treating this field as part of a login,
   * for email fields that are not the account's own (a support address).
   */
  ignorePasswordManagers?: boolean;
  /** Length limits, which password managers read when they make a password. */
  maxLength?: number;
  minLength?: number;
  /**
   * The rules a generated password must follow, in the format password
   * managers (Safari, 1Password) read from the passwordrules attribute.
   * https://developer.apple.com/password-rules/
   */
  passwordRules?: string;
};

type ShellButtonProps = {
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  href?: string;
  loading?: boolean;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "danger" | "ghost" | "primary" | "secondary";
};

const variantMap: Record<
  NonNullable<ShellButtonProps["variant"]>,
  NonNullable<React.ComponentProps<typeof Button>["variant"]>
> = {
  danger: "destructive",
  primary: "default",
  secondary: "outline",
  ghost: "ghost",
};

export function FieldShell({
  autoComplete,
  disabled = false,
  error,
  helper,
  ignorePasswordManagers = false,
  label,
  maxLength,
  minLength,
  name,
  passwordRules,
  onChange,
  placeholder,
  readOnly = true,
  type = "text",
  value,
}: FieldShellProps) {
  const generatedId = useId();
  const inputId = name ?? generatedId;

  return (
    <Field className="gap-2 text-sm">
      <FieldLabel
        className="text-[0.8125rem] font-semibold text-(--secondary)"
        htmlFor={inputId}
      >
        {label}
      </FieldLabel>
      <Input
        aria-describedby={name ? `${name}-description` : undefined}
        aria-invalid={error ? true : undefined}
        autoComplete={autoComplete}
        className={cn(
          "read-only:text-muted-foreground",
          error ? "border-(--danger)" : "",
        )}
        disabled={disabled}
        id={inputId}
        maxLength={maxLength}
        minLength={minLength}
        name={name}
        onChange={onChange}
        placeholder={placeholder}
        readOnly={readOnly}
        type={type}
        value={value ?? ""}
        {...(ignorePasswordManagers
          ? { "data-1p-ignore": "true", "data-lpignore": "true" }
          : {})}
        {...(passwordRules ? { passwordrules: passwordRules } : {})}
      />
      {error ? (
        <FieldError
          className="text-xs font-semibold text-(--danger)"
          id={name ? `${name}-description` : undefined}
        >
          {error}
        </FieldError>
      ) : helper ? (
        <FieldDescription
          className="text-xs leading-5 text-(--tertiary)"
          id={name ? `${name}-description` : undefined}
        >
          {helper}
        </FieldDescription>
      ) : null}
    </Field>
  );
}

export function ShellButton({
  children,
  className = "",
  disabled = false,
  href,
  loading = false,
  onClick,
  type = "button",
  variant = "primary",
}: ShellButtonProps) {
  const buttonVariant = variantMap[variant];
  const shellButtonClassName = cn(
    "min-h-12 px-5.5 text-[0.9375rem]",
    className,
  );
  const content = (
    <>
      {loading ? (
        <span
          aria-hidden="true"
          className="mr-2 inline-flex h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      ) : null}
      {children}
    </>
  );

  if (href && !disabled && !loading) {
    return (
      <Button asChild className={shellButtonClassName} variant={buttonVariant}>
        <Link href={href}>{children}</Link>
      </Button>
    );
  }

  return (
    <Button
      className={shellButtonClassName}
      disabled={disabled || loading}
      onClick={onClick}
      type={type}
      variant={buttonVariant}
    >
      {content}
    </Button>
  );
}

type StaticShellButtonProps = {
  children: ReactNode;
  className?: string;
  variant?: NonNullable<ShellButtonProps["variant"]>;
};

export function StaticShellButton({
  children,
  className = "",
  variant = "primary",
}: StaticShellButtonProps) {
  return (
    <span
      className={cn(
        buttonVariants({ variant: variantMap[variant] }),
        "min-h-12 px-5.5 text-[0.9375rem]",
        className,
      )}
    >
      {children}
    </span>
  );
}
