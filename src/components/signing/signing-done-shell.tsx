import { Brand } from "@/components/layout/brand";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";

const fallbackEnvelopeTitle = "this document";

type SigningDoneShellProps = {
  envelopeTitle?: string | null;
};

export function SigningDoneShell({ envelopeTitle }: SigningDoneShellProps) {
  const resolvedEnvelopeTitle =
    envelopeTitle && envelopeTitle.trim().length > 0
      ? envelopeTitle.trim()
      : fallbackEnvelopeTitle;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-(--border) bg-white">
        <div className="mx-auto flex max-w-[1360px] items-center px-4 py-5 sm:px-6 lg:px-8">
          <Brand href="/" />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1360px] flex-1 items-center justify-center px-4 py-12 sm:px-6 lg:px-8">
        <section className="editorial-panel w-full max-w-[820px] px-6 py-12 text-center sm:px-10 sm:py-16">
          <div
            aria-hidden="true"
            className="mx-auto inline-flex size-20 items-center justify-center border border-[rgba(5,150,105,0.18)] bg-[rgba(5,150,105,0.1)]"
          >
            <svg
              className="size-9 text-chart-4"
              fill="none"
              viewBox="0 0 36 36"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M10 18.5L15.25 23.75L26.5 12.5"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="3"
              />
            </svg>
          </div>

          <h1 className="mt-8 text-[32px] font-extrabold tracking-[-0.05em] text-(--fg) sm:text-[38px]">
            You&apos;re all done.
          </h1>
          <p className="mx-auto mt-5 max-w-[560px] text-base leading-7 text-muted-foreground sm:text-[15px]">
            Your signature has been recorded for{" "}
            <span className="font-semibold text-(--fg)">
              &quot;{resolvedEnvelopeTitle}&quot;
            </span>
            .
          </p>
          <p className="mx-auto mt-4 max-w-[560px] text-base leading-7 text-muted-foreground sm:text-[15px]">
            You&apos;ll receive an email with the signed document once all
            parties have signed.
          </p>
          <p className="mt-8 text-sm font-semibold uppercase tracking-[0.2em] text-(--tertiary)">
            You can close this tab.
          </p>
        </section>
      </main>

      <PublicLegalFooter />
    </div>
  );
}
