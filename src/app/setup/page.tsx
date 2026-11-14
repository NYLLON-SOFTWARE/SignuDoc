import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { connection } from "next/server";

import { BrandingProvider } from "@/components/layout/branding-provider";
import {
  SetupShell,
  type SetupShellView,
} from "@/components/setup/setup-shell";
import { getAuthSession } from "@/lib/auth/server";
import { buildBranding } from "@/lib/branding";
import { ServiceConfigurationError } from "@/lib/services/service-config";
import {
  getSetupState,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";
import { resolveSetupView } from "@/lib/setup";
import { isHostedMode, resolveAppUrl } from "@/lib/utils/env";

function readSiteHost(): string | null {
  try {
    const appUrl = resolveAppUrl(process.env);

    return appUrl ? new URL(appUrl).hostname : null;
  } catch {
    return null;
  }
}

export const metadata: Metadata = {
  description: "Create the administrator account for this site.",
  title: "Set up",
};

async function loadView(): Promise<SetupShellView> {
  try {
    const state = await getSetupState();
    // Only an install that already has accounts cares who is signed in.
    const session =
      state.status === "unclaimed" ? await getAuthSession() : null;
    // The form asks for a support address unless one is saved already.
    // Read fresh, not from the settings cache: this page is opened rarely,
    // and what it asks for should match what setup will accept.
    const stored =
      state.status === "fresh" || state.status === "unclaimed"
        ? await readStoredSettings()
        : null;

    return resolveSetupView(state, {
      storedSupportAddress: stored?.supportAddress ?? null,
      sessionUser: session
        ? {
            email: session.user.email,
            emailVerified: session.user.emailVerified === true,
            id: session.user.id,
          }
        : null,
    });
  } catch (error) {
    // No database connected at all. The page can still say so.
    if (error instanceof ServiceConfigurationError) {
      return { view: "no_database" };
    }

    throw error;
  }
}

// First-run setup. Exists only until the install has an administrator;
// after that it sends everyone to the sign-in page.
export default async function SetupPage() {
  await connection();

  const view = await loadView();

  if (view.view === "complete") {
    redirect("/login");
  }

  return (
    // There is no organization yet, so the page goes by the product's name.
    <BrandingProvider branding={buildBranding(resolveSettings(null))}>
      <SetupShell
        hosted={isHostedMode()}
        onVercel={process.env.VERCEL === "1"}
        resendDomain={process.env.RESEND_EMAIL_DOMAIN?.trim() || null}
        siteHost={readSiteHost()}
        view={view}
      />
    </BrandingProvider>
  );
}
