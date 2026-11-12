import { betterAuth } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins";
import { headers } from "next/headers";
import type { Pool } from "pg";
import { cache } from "react";

import { getDb } from "../db/connection.ts";
import {
  createEmailService,
  type EmailService,
  type TransactionalEmailMessage,
} from "../services/email.ts";
import { withUserEmailLegalFooter } from "../services/email-legal-footer.ts";
import { requireConfigValue } from "../services/service-config.ts";
import {
  getEnv,
  resolveDeploymentOrigins,
  type EnvSource,
} from "../utils/env.ts";

type CreateAppAuthOptions = {
  database?: Pool;
  env?: EnvSource;
  includeNextCookies?: boolean;
};

type AppAuth = ReturnType<typeof createAppAuth>;

let cachedAuth: AppAuth | null = null;

const LOOPBACK_HOST_ALIASES = ["127.0.0.1", "localhost"] as const;

function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === "::1" ||
    LOOPBACK_HOST_ALIASES.includes(
      hostname as (typeof LOOPBACK_HOST_ALIASES)[number],
    )
  );
}

function addTrustedOrigin(
  trustedOrigins: Set<string>,
  origin: string | null | undefined,
) {
  if (!origin) {
    return;
  }

  try {
    const parsedOrigin = new URL(origin);

    trustedOrigins.add(parsedOrigin.origin);

    if (!isLoopbackHost(parsedOrigin.hostname)) {
      return;
    }

    for (const loopbackHost of LOOPBACK_HOST_ALIASES) {
      const aliasOrigin = new URL(parsedOrigin.origin);
      aliasOrigin.hostname = loopbackHost;
      trustedOrigins.add(aliasOrigin.origin);
    }
  } catch {
    return;
  }
}

function buildEmailVerificationMessage(input: { name: string; url: string }) {
  const textBody = [
    `Hi ${input.name},`,
    "",
    "Verify your email address to finish setting up your SignuDoc sender account:",
    input.url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${input.name},</p>`,
    "<p>Verify your email address to finish setting up your SignuDoc sender account.</p>",
    `<p><a href="${input.url}">Verify your email</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter({
    htmlBody,
    textBody,
  });

  return {
    htmlBody: legalFooter.htmlBody,
    subject: "Verify your SignuDoc email",
    template: "email_verification" as const,
    textBody: legalFooter.textBody,
  };
}

function buildChangeEmailConfirmationMessage(input: {
  name: string;
  newEmail: string;
  url: string;
}) {
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Confirm that you want to change your SignuDoc sender email to ${input.newEmail}:`,
    input.url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${input.name},</p>`,
    `<p>Confirm that you want to change your SignuDoc sender email to ${input.newEmail}.</p>`,
    `<p><a href="${input.url}">Confirm this email change</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter({
    htmlBody,
    textBody,
  });

  return {
    htmlBody: legalFooter.htmlBody,
    subject: "Confirm your SignuDoc email change",
    template: "change_email_confirmation" as const,
    textBody: legalFooter.textBody,
  };
}

// The email service is created when a message is sent, not when auth is set
// up. Email that is not configured yet then fails that one message (and is
// logged) instead of taking sign-in down with it.
function sendAuthEmailInBackground(
  getEmailService: () => EmailService,
  message: TransactionalEmailMessage,
) {
  void Promise.resolve()
    .then(() => getEmailService().send(message))
    .catch((error: unknown) => {
      console.error(
        `Failed to send auth email "${message.template}" to ${message.to}:`,
        error,
      );
    });
}

// In production, new passwords are checked against the Have I Been Pwned
// breach list, which needs outbound HTTPS to api.pwnedpasswords.com. If the
// check cannot be reached, sign-up fails rather than accepting the password.
// PASSWORD_BREACH_CHECK=off turns it off for networks without that access
// and for the end-to-end test.
function isPasswordBreachCheckEnabled(env: EnvSource): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.PASSWORD_BREACH_CHECK?.trim().toLowerCase() !== "off"
  );
}

export function createAppAuth({
  database = getDb(),
  env = process.env,
  includeNextCookies = true,
}: CreateAppAuthOptions = {}) {
  const appEnv = getEnv(env);
  const authEnv = appEnv.auth;
  const secret = requireConfigValue(
    "auth",
    "BETTER_AUTH_SECRET",
    authEnv.betterAuthSecret,
  );
  const baseURL = requireConfigValue(
    "auth",
    "BETTER_AUTH_URL",
    authEnv.betterAuthUrl,
  );
  let cachedEmailService: EmailService | null = null;
  const emailService = () => {
    cachedEmailService ??= createEmailService({ env });

    return cachedEmailService;
  };
  const plugins = [
    ...(isPasswordBreachCheckEnabled(env)
      ? [
          haveIBeenPwned({
            customPasswordCompromisedMessage:
              "This password has appeared in a breach. Choose a different password.",
          }),
        ]
      : []),
    ...(includeNextCookies ? [nextCookies()] : []),
  ];
  return betterAuth({
    trustedOrigins: async () => {
      const trustedOrigins = new Set<string>();

      addTrustedOrigin(trustedOrigins, appEnv.appUrl);
      addTrustedOrigin(trustedOrigins, baseURL);

      // On Vercel the same deployment also answers on its own vercel.app
      // URLs, which are the same app and so are trusted too.
      for (const origin of resolveDeploymentOrigins(env)) {
        addTrustedOrigin(trustedOrigins, origin);
      }

      return Array.from(trustedOrigins);
    },
    advanced: {
      // Secure cookies whenever the site is served over HTTPS, which is
      // always in production except for a build run on localhost.
      useSecureCookies: baseURL.startsWith("https://"),
    },
    baseURL,
    database,
    emailVerification: {
      sendOnSignIn: true,
      sendOnSignUp: true,
      sendVerificationEmail: async ({ url, user }) => {
        sendAuthEmailInBackground(emailService, {
          ...buildEmailVerificationMessage({
            name: user.name,
            url,
          }),
          to: user.email,
        });
      },
    },
    emailAndPassword: {
      enabled: true,
      maxPasswordLength: 128,
      minPasswordLength: 15,
      requireEmailVerification: true,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ url, user }) => {
        const textBody = [
          `Hi ${user.name},`,
          "",
          "Use the link below to reset your SignuDoc password:",
          url,
          "",
          "If you didn't request this reset, you can ignore this email.",
        ].join("\n");
        const htmlBody = [
          `<p>Hi ${user.name},</p>`,
          "<p>Use the link below to reset your SignuDoc password.</p>",
          `<p><a href="${url}">Reset your password</a></p>`,
          "<p>If you didn't request this reset, you can ignore this email.</p>",
        ].join("");
        const legalFooter = withUserEmailLegalFooter({
          htmlBody,
          textBody,
        });

        sendAuthEmailInBackground(emailService, {
          htmlBody: legalFooter.htmlBody,
          subject: "Reset your SignuDoc password",
          template: "password_reset",
          textBody: legalFooter.textBody,
          to: user.email,
        });
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
      deferSessionRefresh: true,
    },
    plugins,
    secret,
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ newEmail, url, user }) => {
          sendAuthEmailInBackground(emailService, {
            ...buildChangeEmailConfirmationMessage({
              name: user.name,
              newEmail,
              url,
            }),
            to: user.email,
          });
        },
        updateEmailWithoutVerification: false,
      },
    },
  });
}

export function getAuth(): AppAuth {
  if (cachedAuth) {
    return cachedAuth;
  }

  cachedAuth = createAppAuth();

  return cachedAuth;
}

export async function getAuthSessionFromHeaders(requestHeaders: Headers) {
  return getAuth().api.getSession({
    headers: requestHeaders,
  });
}

const getCachedAuthSession = cache(async () => {
  const requestHeaders = await headers();

  return getAuthSessionFromHeaders(requestHeaders);
});

export function getAuthSession() {
  return getCachedAuthSession();
}
