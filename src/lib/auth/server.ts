import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { haveIBeenPwned } from "better-auth/plugins";
import { headers } from "next/headers";
import { after } from "next/server";
import type { Pool } from "pg";
import { cache } from "react";

import { type Branding } from "../branding.ts";
import { getDb } from "../db/connection.ts";
import {
  createEmailService,
  type EmailService,
  type TransactionalEmailMessage,
} from "../services/email.ts";
import { withUserEmailLegalFooter } from "../services/email-legal-footer.ts";
import { consumeRateLimit } from "../security/rate-limit.ts";
import { getClientIpHeaderNames } from "../security/request.ts";
import { requireConfigValue } from "../services/service-config.ts";
import { getBranding, getSettings, getSetupState } from "../settings.ts";
import { evaluateSignup } from "../signup-policy.ts";
import {
  getEnv,
  resolveDeploymentOrigins,
  type EnvSource,
} from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import { isRunningSetup } from "./setup-context.ts";

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

function buildEmailVerificationMessage(input: {
  branding: Branding;
  name: string;
  url: string;
}) {
  const { productName } = input.branding;
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Verify your email address to finish setting up your ${productName} sender account:`,
    input.url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.name)},</p>`,
    `<p>Verify your email address to finish setting up your ${escapeHtml(productName)} sender account.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Verify your email</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject: `Verify your ${productName} email`,
    template: "email_verification" as const,
    textBody: legalFooter.textBody,
  };
}

function buildChangeEmailConfirmationMessage(input: {
  branding: Branding;
  name: string;
  newEmail: string;
  url: string;
}) {
  const { productName } = input.branding;
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Confirm that you want to change your ${productName} sender email to ${input.newEmail}:`,
    input.url,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.name)},</p>`,
    `<p>Confirm that you want to change your ${escapeHtml(productName)} sender email to ${escapeHtml(input.newEmail)}.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Confirm this email change</a></p>`,
    "<p>If you didn't request this, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject: `Confirm your ${productName} email change`,
    template: "change_email_confirmation" as const,
    textBody: legalFooter.textBody,
  };
}

function buildPasswordResetMessage(input: {
  branding: Branding;
  name: string;
  url: string;
}) {
  const { productName } = input.branding;
  const textBody = [
    `Hi ${input.name},`,
    "",
    `Use the link below to reset your ${productName} password:`,
    input.url,
    "",
    "If you didn't request this reset, you can ignore this email.",
  ].join("\n");
  const htmlBody = [
    `<p>Hi ${escapeHtml(input.name)},</p>`,
    `<p>Use the link below to reset your ${escapeHtml(productName)} password.</p>`,
    `<p><a href="${escapeHtml(input.url)}">Reset your password</a></p>`,
    "<p>If you didn't request this reset, you can ignore this email.</p>",
  ].join("");
  const legalFooter = withUserEmailLegalFooter(
    {
      htmlBody,
      textBody,
    },
    input.branding,
  );

  return {
    htmlBody: legalFooter.htmlBody,
    subject: `Reset your ${productName} password`,
    template: "password_reset" as const,
    textBody: legalFooter.textBody,
  };
}

type AuthEmailContent = Omit<TransactionalEmailMessage, "to">;

// Auth emails are sent after the response, so sign-in is never slowed down
// by the mail provider, and a message that cannot be sent (email that is not
// configured yet, for one) is logged instead of failing the request.
//
// after() keeps a Vercel function alive until the message has gone out. A
// promise that nothing waits for could be cut off when the function is
// suspended at the end of the response.
// https://nextjs.org/docs/app/api-reference/functions/after
function sendAuthEmailInBackground(input: {
  buildContent: (branding: Branding) => AuthEmailContent;
  env: EnvSource;
  getEmailService: () => EmailService;
  template: TransactionalEmailMessage["template"];
  to: string;
}) {
  const deliver = async () => {
    try {
      const branding = await getBranding(input.env);

      await input.getEmailService().send({
        ...input.buildContent(branding),
        to: input.to,
      });
    } catch (error) {
      console.error(
        `Failed to send auth email "${input.template}" to ${input.to}:`,
        error,
      );
    }
  };

  try {
    after(deliver);
  } catch {
    // Not inside a request (a script or the auth CLI), so there is no
    // response to wait for.
    void deliver();
  }
}

/**
 * Applies this install's sign-up rule to one email address. Before first-run
 * setup has happened nobody can sign up at all: the first account is the
 * administrator's, and only the setup page creates it.
 */
export async function evaluateSignupRequest(
  email: string,
  env: EnvSource = process.env,
) {
  const setupState = await getSetupState();

  if (setupState.status === "fresh") {
    return {
      allowed: false as const,
      code: "setup_required" as const,
      message: "This site has not been set up yet.",
    };
  }

  return evaluateSignup(email, await getSettings(env));
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
      // Where the visitor's address is read from, for rate limits and
      // sessions: the same headers the rest of the app trusts.
      ipAddress: { ipAddressHeaders: getClientIpHeaderNames(env) },
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
        // The administrator created by first-run setup is verified by
        // setup itself; there is no working email to send through yet.
        if (isRunningSetup()) {
          return;
        }

        sendAuthEmailInBackground({
          buildContent: (branding) =>
            buildEmailVerificationMessage({
              branding,
              name: user.name,
              url,
            }),
          env,
          getEmailService: emailService,
          template: "email_verification",
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
        sendAuthEmailInBackground({
          buildContent: (branding) =>
            buildPasswordResetMessage({
              branding,
              name: user.name,
              url,
            }),
          env,
          getEmailService: emailService,
          template: "password_reset",
          to: user.email,
        });
      },
    },
    hooks: {
      // The sign-up rule, asked before anything else so the person filling
      // in the form is told. The same rule is enforced again in
      // validateUserInfo below, but a refusal there is answered as if the
      // sign-up had worked: Better Auth cannot let it look different from
      // "this address already has an account". The rule is about the
      // address's domain and is printed on the sign-up page, so saying it
      // here gives nothing away.
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/sign-up/email" || isRunningSetup()) {
          return;
        }

        const body: unknown = ctx.body;
        const email =
          typeof body === "object" &&
          body !== null &&
          "email" in body &&
          typeof body.email === "string"
            ? body.email
            : "";
        const decision = await evaluateSignupRequest(email, env);

        if (!decision.allowed) {
          throw new APIError("FORBIDDEN", {
            code: decision.code,
            message: decision.message,
          });
        }
      }),
    },
    // Better Auth limits its own routes (three sign-in or sign-up attempts
    // in ten seconds, for one). Its counts go in the same Postgres table as
    // the app's other limits, so they hold across instances.
    rateLimit: {
      customStorage: {
        consume: async (key, rule) => {
          const decision = await consumeRateLimit({
            key: `auth:${key}`,
            limit: rule.max,
            windowMs: rule.window * 1000,
          });

          return {
            allowed: decision.allowed,
            retryAfter: decision.allowed ? null : decision.retryAfterSeconds,
          };
        },
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
          sendAuthEmailInBackground({
            buildContent: (branding) =>
              buildChangeEmailConfirmationMessage({
                branding,
                name: user.name,
                newEmail,
                url,
              }),
            env,
            getEmailService: emailService,
            template: "change_email_confirmation",
            to: user.email,
          });
        },
        updateEmailWithoutVerification: false,
      },
      // Decides who may create an account. Runs for every new user, however
      // the account comes to be created, so the check in hooks.before above
      // is not the only thing standing in the way.
      validateUserInfo: async ({ source, user }) => {
        if (source.action !== "create-user" || isRunningSetup()) {
          return;
        }

        const decision = await evaluateSignupRequest(
          typeof user.email === "string" ? user.email : "",
          env,
        );

        if (!decision.allowed) {
          return {
            error: decision.code,
            errorDescription: decision.message,
          };
        }
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
