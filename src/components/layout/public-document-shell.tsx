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
  lastUpdated: string;
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
    <div className="flex min-h-screen flex-col bg-white text-(--fg)">
      <header className="border-b border-(--border) bg-white">
        <div className="editorial-shell flex items-center justify-between gap-4 px-0 py-5">
          <Brand href="/" />
          <PublicSessionMenu />
        </div>
      </header>

      <main className="flex-1 py-10 sm:py-12 lg:py-14">
        <div className="editorial-shell">
          <article
            className="editorial-panel overflow-hidden"
            data-animate="enter"
          >
            <div className="border-b border-(--border) px-6 py-8 sm:px-10 sm:py-10">
              <p className="editorial-meta">Last updated {lastUpdated}</p>
              <h1 className="mt-4 max-w-[18ch] text-[clamp(2.3rem,5vw,4rem)] font-extrabold leading-[1.02] tracking-[-0.045em] text-black">
                {title}
              </h1>
              <p className="mt-5 max-w-[760px] text-base leading-7 text-muted-foreground sm:text-[1.02rem]">
                {description}
              </p>
            </div>

            <div className="space-y-10 px-6 py-8 text-sm leading-7 text-muted-foreground sm:px-10 sm:py-10 sm:text-[15px]">
              {children}
            </div>
          </article>
        </div>
      </main>

      <PublicLegalFooter />
    </div>
  );
}
