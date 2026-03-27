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
