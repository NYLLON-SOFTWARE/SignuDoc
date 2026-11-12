import type { ReactNode } from "react";
import { connection } from "next/server";

import { Brand } from "@/components/layout/brand";
import { BrandingProvider } from "@/components/layout/branding-provider";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { PublicSessionMenu } from "@/components/layout/public-session-menu";
import { buildBranding, type Branding } from "@/lib/branding";
import { getBranding, resolveSettings } from "@/lib/settings";

type PublicDocumentShellProps = {
  children: ReactNode;
  description: string;
  /** For policies. A page that is a tool, not a policy, leaves it out. */
  lastUpdated?: string;
  title: string;
};

async function loadBranding(): Promise<Branding> {
  try {
    return await getBranding();
  } catch {
    // A page of text is not worth failing over a database that cannot be
    // reached. This is the install before anything was saved: still its own
    // footer links, and never the hosted service's.
    return buildBranding(resolveSettings(null));
  }
}

// These pages sit outside the layouts that hand branding down, and some of
// them are on every install: the signer privacy notice, what signatures are
// for, document verification and the expired download link. So the shell
// looks up what this install calls itself. Without that, such a page would
// carry the hosted service's name and link to pages only it has.
export async function PublicDocumentShell({
  children,
  description,
  lastUpdated,
  title,
}: PublicDocumentShellProps) {
  // Read when the page is requested, so one build serves any install.
  await connection();

  const branding = await loadBranding();

  return (
    <BrandingProvider branding={branding}>
      <PublicDocumentPage
        description={description}
        lastUpdated={lastUpdated}
        title={title}
      >
        {children}
      </PublicDocumentPage>
    </BrandingProvider>
  );
}

function PublicDocumentPage({
  children,
  description,
  lastUpdated,
  title,
}: PublicDocumentShellProps) {
  return (
    <div className="flex min-h-screen flex-col text-(--fg)">
      <header>
        <div className="page-width flex items-center justify-between gap-4 py-4">
          <Brand href="/" />
          <PublicSessionMenu />
        </div>
      </header>

      <main className="flex-1 pb-10 pt-2 sm:pt-4">
        <div className="page-width">
          <article
            className="panel mx-auto max-w-[880px] overflow-hidden"
            data-animate="enter"
          >
            <div className="px-6 pb-2 pt-9 sm:px-12 sm:pt-12">
              {lastUpdated ? (
                <p className="section-eyebrow mb-3">
                  Last updated {lastUpdated}
                </p>
              ) : null}
              <h1 className="max-w-[20ch] text-[clamp(2rem,4.5vw,3rem)] font-extrabold leading-[1.06] tracking-[-0.035em] text-(--fg)">
                {title}
              </h1>
              <p className="mt-4 max-w-[680px] text-base leading-7 text-(--secondary) sm:text-[1.0625rem]">
                {description}
              </p>
            </div>

            <div className="space-y-9 px-6 py-8 text-[0.9375rem] leading-7 text-(--secondary) sm:px-12 sm:pb-12 sm:pt-9">
              {children}
            </div>
          </article>
        </div>
      </main>

      <PublicLegalFooter />
    </div>
  );
}
