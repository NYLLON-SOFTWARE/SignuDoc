import { NextResponse } from "next/server";

import { requireAdminSession } from "@/lib/auth/admin";
import { getDb, withTransaction } from "@/lib/db/connection";
import {
  diffSettings,
  OrganizationSettingsError,
  toOrganizationSettingsView,
  updateOrganizationSettings,
} from "@/lib/organization-settings";
import { logRouteError } from "@/lib/security/logging";
import {
  applyRateLimit,
  buildRateLimitKey,
} from "@/lib/security/route-controls";
import {
  getClientIpAddress,
  getRequestPathname,
  getRequestUserAgent,
} from "@/lib/security/request";
import { recordSystemAuditEvent } from "@/lib/services/system-audit";
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
    const current = await getSettings();

    // The change and its line in the install's audit trail land together.
    await withTransaction(async (tx) => {
      const before = await readStoredSettings(tx);
      const after = await updateOrganizationSettings(body ?? {}, current, tx);
      const changes = diffSettings(before, after);

      if (Object.keys(changes).length > 0) {
        await recordSystemAuditEvent(
          {
            actorEmail: session.user.email,
            actorUserId: session.user.id,
            event: "settings_changed",
            ipAddress: getClientIpAddress(request.headers),
            metadata: { changes },
            userAgent: getRequestUserAgent(request.headers),
          },
          tx,
        );
      }
    }, getDb());

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
