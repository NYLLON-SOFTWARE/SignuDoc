import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import {
  OrganizationSettingsError,
  toOrganizationSettingsView,
  updateOrganizationSettings,
} from "@/lib/organization-settings";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import {
  getSettings,
  readStoredSettings,
  resolveSettings,
} from "@/lib/settings";

// The Organization tab in Settings. Administrators only.

export async function PUT(request: Request) {
  const sessionResult = await requireAdminSession(request);

  if (sessionResult instanceof Response) {
    return sessionResult;
  }

  const session = sessionResult;
  const rateLimitResponse = await applyRateLimit({
    category: "organization_settings_update",
    key: buildRateLimitKey(["organization-settings", session.user.id]),
    limit: 30,
    request,
    userId: session.user.id,
    windowMs: 10 * 60 * 1000,
  });

  if (rateLimitResponse) {
    return rateLimitResponse;
  }

  const body: unknown = await request.json().catch(() => null);

  try {
    await updateOrganizationSettings(body ?? {}, await getSettings());

    // Read back rather than trusting the cache, so the form shows exactly
    // what is stored.
    const saved = resolveSettings(await readStoredSettings());

    return NextResponse.json({ settings: toOrganizationSettingsView(saved) });
  } catch (error) {
    if (error instanceof OrganizationSettingsError) {
      return NextResponse.json(
        { error: error.message, fieldErrors: error.fieldErrors },
        { status: 400 },
      );
    }

    logRouteError(error, {
      category: "organization_settings_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while saving organization settings.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return NextResponse.json(
      { error: "The settings could not be saved." },
      { status: 500 },
    );
  }
}
