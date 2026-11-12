import type { ReactNode } from "react";

import { Brand } from "@/components/layout/brand";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { PublicSessionMenu } from "@/components/layout/public-session-menu";

type PublicDocumentShellProps = {
  children: ReactNode;
  description: string;
  lastUpdated: string;
  title: string;
};

export function PublicDocumentShell({
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
              <p className="section-eyebrow">Last updated {lastUpdated}</p>
              <h1 className="mt-3 max-w-[20ch] text-[clamp(2rem,4.5vw,3rem)] font-extrabold leading-[1.06] tracking-[-0.035em] text-(--fg)">
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
