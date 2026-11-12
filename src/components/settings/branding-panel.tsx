"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type CSSProperties, type ChangeEvent } from "react";

import { BrandLogo } from "@/components/layout/brand";
import {
  DEFAULT_BRAND_COLOR,
  DEFAULT_BRAND_PALETTE,
  brandPaletteVariables,
  buildBrandPalette,
  normalizeBrandColor,
} from "@/lib/brand-color";
import { LOGO_CONTENT_TYPES, MAX_LOGO_BYTES } from "@/lib/branding";

// The install's own logo and color, on the Organization tab in Settings.
//
// The logo is saved as soon as it is chosen. The color is part of the form
// around this panel and is saved with it.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type BrandingPanelProps = {
  brandColor: string;
  brandColorError?: string;
  disabled: boolean;
  logoUrl: string | null;
  onBrandColorChange: (value: string) => void;
  onLogoChange: (logoUrl: string | null) => void;
};

type LogoResponse = { error?: string; logoUrl?: string | null } | null;

export function BrandingPanel({
  brandColor,
  brandColorError,
  disabled,
  logoUrl,
  onBrandColorChange,
  onLogoChange,
}: BrandingPanelProps) {
  const router = useRouter();
  const fileInput = useRef<HTMLInputElement>(null);
  const [logoError, setLogoError] = useState<string | null>(null);
  const [logoBusy, setLogoBusy] = useState<"removing" | "uploading" | null>(
    null,
  );

  const typedColor = normalizeBrandColor(brandColor);
  const palette =
    (typedColor ? buildBrandPalette(typedColor) : null) ??
    DEFAULT_BRAND_PALETTE;
  const darkened = typedColor !== null && palette.accent !== typedColor;

  async function sendLogo(file: File | null) {
    setLogoError(null);
    setLogoBusy(file ? "uploading" : "removing");

    try {
      const response = await fetch("/api/admin/logo", {
        body: file,
        headers: file ? { "content-type": "application/octet-stream" } : {},
        method: file ? "PUT" : "DELETE",
      });
      const payload = (await response.json().catch(() => null)) as LogoResponse;

      if (!response.ok || !payload || payload.logoUrl === undefined) {
        setLogoError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      onLogoChange(payload.logoUrl);
      // The header above this page shows the logo too.
      router.refresh();
    } catch {
      setLogoError(GENERIC_ERROR_MESSAGE);
    } finally {
      setLogoBusy(null);
    }
  }

  function handleFileChosen(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;

    // So choosing the same file again, after an error, is still a change.
    event.target.value = "";

    if (!file) {
      return;
    }

    if (!(LOGO_CONTENT_TYPES as readonly string[]).includes(file.type)) {
      setLogoError("The logo must be a PNG, JPEG or WebP image.");
      return;
    }

    if (file.size > MAX_LOGO_BYTES) {
      setLogoError("The logo must be 512 KB or smaller.");
      return;
    }

    void sendLogo(file);
  }

  const busy = disabled || logoBusy !== null;

  return (
    <div className="space-y-5 border-t border-(--border) pt-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          Logo and color
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Optional. Your logo goes in the header of this site, on the pages
          signers see and at the top of emails. Your color is used for buttons
          and links.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="well space-y-4 p-4">
          <p className="text-[0.8125rem] font-semibold text-(--secondary)">
            Logo
          </p>
          <div className="flex min-h-16 items-center rounded-xl bg-(--paper) px-4 py-3">
            {logoUrl ? (
              <BrandLogo src={logoUrl} />
            ) : (
              <span className="text-sm leading-6 text-(--tertiary)">
                No logo yet. The header shows your organization&rsquo;s name.
              </span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              accept={LOGO_CONTENT_TYPES.join(",")}
              aria-label="Logo image"
              className="hidden"
              disabled={busy}
              onChange={handleFileChosen}
              ref={fileInput}
              tabIndex={-1}
              type="file"
            />
            <button
              className="btn-quiet"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
              type="button"
            >
              {logoBusy === "uploading"
                ? "Uploading..."
                : logoUrl
                  ? "Replace logo"
                  : "Upload a logo"}
            </button>
            {logoUrl ? (
              <button
                className="btn-quiet btn-quiet-danger"
                disabled={busy}
                onClick={() => void sendLogo(null)}
                type="button"
              >
                {logoBusy === "removing" ? "Removing..." : "Remove logo"}
              </button>
            ) : null}
          </div>
          {logoError ? (
            <p className="text-xs font-semibold text-(--danger)" role="alert">
              {logoError}
            </p>
          ) : (
            <p className="text-xs leading-5 text-(--tertiary)">
              PNG, JPEG or WebP, up to 512 KB. A wide logo on a transparent
              background works best. It is saved as soon as you choose it.
            </p>
          )}
        </div>

        <div className="well space-y-4 p-4">
          <label
            className="block text-[0.8125rem] font-semibold text-(--secondary)"
            htmlFor="brand-color"
          >
            Brand color
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Color picker"
              className="size-12 shrink-0 cursor-pointer rounded-xl border-[1.5px] border-(--border-strong) bg-(--paper) p-1 disabled:cursor-not-allowed"
              disabled={disabled}
              onChange={(event) => onBrandColorChange(event.target.value)}
              type="color"
              value={typedColor ?? DEFAULT_BRAND_COLOR}
            />
            <input
              aria-describedby="brand-color-description"
              aria-invalid={brandColorError ? true : undefined}
              autoCapitalize="none"
              autoComplete="off"
              className="field-input w-36 font-mono"
              disabled={disabled}
              id="brand-color"
              maxLength={16}
              name="brand-color"
              onChange={(event) => onBrandColorChange(event.target.value)}
              placeholder={DEFAULT_BRAND_COLOR}
              spellCheck={false}
              value={brandColor}
            />
            {brandColor ? (
              <button
                className="btn-quiet"
                disabled={disabled}
                onClick={() => onBrandColorChange("")}
                type="button"
              >
                Use the default
              </button>
            ) : null}
          </div>
          {/* What the color will look like, before it is saved. */}
          <div
            aria-hidden="true"
            className="flex flex-wrap items-center gap-3 rounded-xl bg-(--paper) px-4 py-3"
            style={brandPaletteVariables(palette) as CSSProperties}
          >
            <span className="inline-flex min-h-9 items-center rounded-[0.75rem] bg-(--accent) px-3.5 text-[0.8125rem] font-bold text-white">
              Button
            </span>
            <span className="pill pill-accent">Status</span>
            <span className="text-[0.8125rem] font-semibold text-(--accent-ink) underline decoration-[rgb(var(--accent-rgb)/0.35)] underline-offset-4">
              Link
            </span>
          </div>
          {brandColorError ? (
            <p
              className="text-xs font-semibold text-(--danger)"
              id="brand-color-description"
              role="alert"
            >
              {brandColorError}
            </p>
          ) : (
            <p
              className="text-xs leading-5 text-(--tertiary)"
              id="brand-color-description"
            >
              {darkened
                ? "This color is too light for white text to be read on it, so a darker shade of it is used."
                : "Six letters and digits, such as #1a73e8. Leave empty for the default. Saved with the button below."}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
