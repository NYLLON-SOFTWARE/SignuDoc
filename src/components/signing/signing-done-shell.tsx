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
    <div className="flex min-h-screen flex-col">
      <header>
        <div className="page-width flex items-center py-4">
          <Brand href="/" />
        </div>
      </header>

      <main className="page-width flex flex-1 items-center justify-center py-10">
        <section
          className="panel w-full max-w-[640px] px-6 py-12 text-center sm:px-12 sm:py-16"
          data-animate="enter"
        >
          <div
            aria-hidden="true"
            className="mx-auto inline-flex size-[4.5rem] items-center justify-center rounded-full bg-(--success-soft)"
          >
            <svg
              className="size-9 text-(--success)"
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

          <h1 className="mt-7 text-[clamp(1.875rem,4.5vw,2.375rem)] font-extrabold tracking-[-0.035em] text-(--fg)">
            You&apos;re all done.
          </h1>
          <p className="mx-auto mt-4 max-w-[480px] text-base leading-7 text-(--secondary)">
            Your signature has been recorded for{" "}
            <span className="font-bold text-(--fg)">
              &quot;{resolvedEnvelopeTitle}&quot;
            </span>
            .
          </p>
          <p className="mx-auto mt-3 max-w-[480px] text-base leading-7 text-(--secondary)">
            You&apos;ll receive an email with the signed document once all
            parties have signed.
          </p>
          <p className="mt-8 inline-flex rounded-full bg-(--surface) px-4 py-2 text-sm font-semibold text-(--secondary)">
            You can close this tab.
          </p>
        </section>
      </main>

      <PublicLegalFooter />
    </div>
  );
}
