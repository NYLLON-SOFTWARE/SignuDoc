import { APIError, betterAuth } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth, haveIBeenPwned, twoFactor } from "better-auth/plugins";
import { headers } from "next/headers";
import { redirect, unstable_rethrow } from "next/navigation";
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
import {
  getClientIpHeaderNames,
  getRequestClient,
  readClientIpSettings,
} from "../security/request.ts";
import {
  requireConfigValue,
  ServiceConfigurationError,
} from "../services/service-config.ts";
import {
  evaluateSignupRequest,
  getBranding,
  getSettings,
  isMissingSchemaError,
} from "../settings.ts";
import { enforceSessionLimits } from "../session-controls.ts";
import { clearFailedSignIns } from "../sign-in-security.ts";
import {
  getEnv,
  resolveDeploymentOrigins,
  type EnvSource,
} from "../utils/env.ts";
import { escapeHtml } from "../utils/html.ts";
import { isRunningSetup } from "./setup-context.ts";
import { signInEvents } from "./sign-in-events.ts";
import {
  isSsoEmailVerified,
  mayUsePassword,
  readPasswordSignInPolicy,
  readSsoConfig,
  SSO_PROVIDER_ID,
} from "./sso.ts";
import { recordSystemAuditEvent } from "../services/system-audit.ts";

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

// Where a password is used or handed out. A reset link is only sent where
// a password may be used, so turning password sign-in off cannot be undone
// with "Forgot your password?".
const PASSWORD_PATHS = new Set([
  "/request-password-reset",
  "/sign-in/email",
  "/sign-up/email",
]);

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
  const sso = readSsoConfig(env);
  const passwordPolicy = readPasswordSignInPolicy(env);
  const plugins = [
    // Single sign-on with the organization's identity provider (sso.ts).
    // Its sign-ins do not ask for this app's second step: the provider's
    // own sign-in, with its own MFA, is the check.
    ...(sso
      ? [
          genericOAuth({
            config: [
              {
                clientId: sso.clientId,
                clientSecret: sso.clientSecret,
                discoveryUrl: sso.discoveryUrl,
                // A provider whose discovery cannot vouch for its ID tokens
                // is left out rather than trusted unchecked.
                requireIdTokenVerification: true,
                // An address counts as verified only when the provider
                // says so: a sign-in with a verified address is tied to the
                // existing account with that address, so a missing claim
                // must not count. See isSsoEmailVerified in sso.ts.
                mapProfileToUser: (profile) => ({
                  emailVerified: isSsoEmailVerified(profile),
                }),
                name: sso.name,
                pkce: true,
                providerId: SSO_PROVIDER_ID,
                scopes: ["openid", "email", "profile"],
              },
            ],
          }),
        ]
      : []),
    ...(isPasswordBreachCheckEnabled(env)
      ? [
          haveIBeenPwned({
            customPasswordCompromisedMessage:
              "This password has appeared in a breach. Choose a different password.",
          }),
        ]
      : []),
    // Two-step sign-in with an authenticator app, and ten single-use backup
    // codes for when the phone is not at hand. Both are stored encrypted
    // with BETTER_AUTH_SECRET. "Trust this device" is not offered, so every
    // sign-in asks for the second step.
    twoFactor({
      accountLockout: {
        durationSeconds: 15 * 60,
        enabled: true,
        maxFailedAttempts: 10,
      },
      backupCodeOptions: { amount: 10, length: 10 },
      skipVerificationOnEnable: false,
    }),
    // After the two-factor plugin: see sign-in-events.ts.
    signInEvents(),
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
      // The tables are made by this app's own migrations (db/migrations),
      // and the setup page already says so when they are missing. Better
      // Auth's check would add nothing but a failure it remembers for the
      // life of the process: an app that was opened before its database was
      // migrated would refuse every sign-in until it was restarted.
      database: { validateSchema: false },
      // Where the visitor's address is read from, for rate limits and
      // sessions: the same headers, and the same trusted proxies, the rest
      // of the app reads (src/lib/security/request.ts).
      ipAddress: {
        ipAddressHeaders: getClientIpHeaderNames(env),
        trustedProxies: readClientIpSettings(env)?.trustedProxies,
      },
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
      onPasswordReset: async ({ user }, request) => {
        try {
          // The new password ends a lockout from wrong guesses at the old one.
          await clearFailedSignIns(user.email);
          await recordSystemAuditEvent({
            actorEmail: user.email,
            actorUserId: user.id,
            event: "password_reset",
            targetUserId: user.id,
            ...getRequestClient(request?.headers, env),
          });
        } catch (error) {
          console.error("[auth] Could not record a password reset:", error);
        }
      },
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
        if (isRunningSetup()) {
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

        // With password sign-in turned off, only the addresses kept for
        // when the identity provider is down may use one (sso.ts).
        if (
          sso &&
          PASSWORD_PATHS.has(ctx.path ?? "") &&
          !mayUsePassword(passwordPolicy, email)
        ) {
          throw new APIError("FORBIDDEN", {
            code: "PASSWORD_SIGN_IN_OFF",
            message: `Password sign-in is turned off here. Continue with ${sso.name} instead.`,
          });
        }

        if (ctx.path !== "/sign-up/email") {
          return;
        }

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
  const session = await getAuth().api.getSession({
    headers: requestHeaders,
  });

  if (!session) {
    return null;
  }

  // The session cookie can vouch for a session for a few minutes on its
  // own. Its row decides: one that was ended (signed out everywhere, reset
  // by an administrator) or that is past the install's limits does not
  // count. See session-controls.ts.
  try {
    const allowed = await enforceSessionLimits(
      session.session.token,
      await getSettings(),
    );

    return allowed ? session : null;
  } catch (error) {
    // A database from before the session controls: nothing to enforce yet.
    if (isMissingSchemaError(error)) {
      return session;
    }

    throw error;
  }
}

const getCachedAuthSession = cache(async () => {
  const requestHeaders = await headers();

  return getAuthSessionFromHeaders(requestHeaders);
});

export function getAuthSession() {
  return getCachedAuthSession();
}

/**
 * For the sign-in and sign-up pages: someone who is already signed in is
 * sent on to their documents. This asks the auth server, so a cookie left
 * over from a session that no longer exists does not count as signed in.
 */
export async function redirectIfSignedIn(): Promise<void> {
  let signedIn = false;

  try {
    signedIn = (await getAuthSession()) !== null;
  } catch (error) {
    // Next.js throws to say a page cannot be built ahead of time. That is
    // not a failure, and it is Next's to handle.
    unstable_rethrow(error);

    // Not being able to ask is no reason to fail a page that shows a form.
    if (!(error instanceof ServiceConfigurationError)) {
      console.error("[auth] Could not check for a session:", error);
    }
  }

  if (signedIn) {
    redirect("/dashboard");
  }
}
