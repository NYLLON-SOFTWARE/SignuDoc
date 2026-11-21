/* eslint-disable @next/next/no-img-element -- drawn into a PNG by next/og, not a page */
import { ImageResponse } from "next/og";

import { requireAdminSession } from "@/lib/auth/admin";
import { DEFAULT_BRAND_COLOR } from "@/lib/brand-color";
import { readBrandLogo } from "@/lib/brand-logo";
import { logRouteError } from "@/lib/security/logging";
import { getClientIpAddress, getRequestPathname } from "@/lib/security/request";
import { getBranding } from "@/lib/settings";

// The Slack app's icon, 512 by 512, to download from Settings,
// Notifications and upload in Slack (a manifest cannot carry an icon). It
// is the install's logo, on its colour when one is set or on white, and
// SignuDoc's own mark when there is no logo. Administrators only.

const SIZE = 512;

// src/app/icon.svg, drawn to the edges: Slack rounds the corners itself.
const SIGNUDOC_MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" fill="${DEFAULT_BRAND_COLOR}"/><path d="M13 42C22 42 24.5 21 32.5 21C40.5 21 38 40 46 40C50.5 40 51 33.5 55 33.5" stroke="#FFFFFF" stroke-linecap="round" stroke-linejoin="round" stroke-width="6"/></svg>`;

function dataUrl(contentType: string, bytes: Uint8Array | string): string {
  const buffer =
    typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);

  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

async function iconContent() {
  const branding = await getBranding();
  const logo = branding.logoUrl ? await readBrandLogo() : null;
  const background = branding.brandColor;

  // The image renderer reads PNG and JPEG; a WebP logo is shown as the
  // organization's initial instead.
  if (logo && logo.contentType !== "image/webp") {
    const image = (
      <img
        alt=""
        height={background ? 300 : 400}
        src={dataUrl(logo.contentType, logo.bytes)}
        style={{ objectFit: "contain" }}
        width={background ? 300 : 400}
      />
    );

    return (
      <div
        style={{
          alignItems: "center",
          background: background ?? "#ffffff",
          display: "flex",
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {background ? (
          <div
            style={{
              alignItems: "center",
              background: "#ffffff",
              borderRadius: 72,
              display: "flex",
              height: 392,
              justifyContent: "center",
              width: 392,
            }}
          >
            {image}
          </div>
        ) : (
          image
        )}
      </div>
    );
  }

  if (logo) {
    const initial = branding.productName.trim().charAt(0).toUpperCase();

    return (
      <div
        style={{
          alignItems: "center",
          background: background ?? DEFAULT_BRAND_COLOR,
          color: "#ffffff",
          display: "flex",
          fontSize: 300,
          fontWeight: 700,
          height: "100%",
          justifyContent: "center",
          width: "100%",
        }}
      >
        {initial || "S"}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", height: "100%", width: "100%" }}>
      <img
        alt=""
        height={SIZE}
        src={dataUrl("image/svg+xml", SIGNUDOC_MARK)}
        width={SIZE}
      />
    </div>
  );
}

export async function GET(request: Request) {
  const session = await requireAdminSession(request);

  if (session instanceof Response) {
    return session;
  }

  // ?download=1 saves it as a file; otherwise it is shown (the preview
  // of messages on the same page uses it as the app's picture).
  const download = new URL(request.url).searchParams.get("download") === "1";

  try {
    const image = new ImageResponse(await iconContent(), {
      headers: {
        "cache-control": "private, max-age=300",
        "content-disposition": download
          ? `attachment; filename="slack-app-icon.png"`
          : "inline",
      },
      height: SIZE,
      width: SIZE,
    });

    // The picture is drawn while its body is read, after a 200 would have gone
    // out. Reading it here lets a drawing failure reach the catch below.
    const body = await image.arrayBuffer();

    return new Response(body, { headers: image.headers, status: 200 });
  } catch (error) {
    logRouteError(error, {
      category: "notification_settings_failure",
      ipAddress: getClientIpAddress(request.headers),
      message: "Unexpected failure while drawing the Slack app icon.",
      path: getRequestPathname(request),
      userId: session.user.id,
    });

    return new Response(null, {
      headers: { "cache-control": "no-store" },
      status: 500,
    });
  }
}
