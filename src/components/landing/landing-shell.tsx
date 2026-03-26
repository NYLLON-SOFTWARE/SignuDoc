import type { ReactNode } from "react";
import Link from "next/link";
import { Archivo, IBM_Plex_Mono } from "next/font/google";

import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { LandingDashboardPreview } from "@/components/landing/dashboard-preview";
import { resolveShellState } from "@/components/shared/shell-state";

const archivo = Archivo({
  display: "swap",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800", "900"],
});

const ibmPlexMono = IBM_Plex_Mono({
  display: "swap",
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
});

export const landingShellStates = ["default", "authenticated"] as const;

export type LandingShellState = (typeof landingShellStates)[number];

type LandingShellProps = {
  initialState?: LandingShellState | string | string[] | null;
};

type WorkflowStep = {
  body: string;
  title: string;
};

type FaqItem = {
  answer: string;
  question: string;
};

const workflowSteps: readonly WorkflowStep[] = [
  {
    title: "Upload your PDF",
    body: "Bring the contract you already wrote. No template rebuilding.",
  },
  {
    title: "Add signers",
    body: "Pick who signs first, second, third. Each person gets invited after the last one finishes.",
  },
  {
    title: "Place fields",
    body: "Drop signature, initials, date, text, and checkbox fields onto the page.",
  },
  {
    title: "Send and track",
    body: "Fire off a signing link. Nudge the slow ones. Download the final PDF.",
  },
] as const;

type ComparisonRow = {
  feature: string;
  signudoc: string | boolean;
  docusign: string | boolean;
};

const comparisonRows: readonly ComparisonRow[] = [
  { feature: "Price", signudoc: "Free forever", docusign: "$10–15/mo" },
  { feature: "Envelopes per month", signudoc: "Unlimited", docusign: "5" },
  {
    feature: "Signers per document",
    signudoc: "Up to 10",
    docusign: "Varies by plan",
  },
  { feature: "Reminders", signudoc: true, docusign: "Standard+ ($25+/mo)" },
] as const;

const faqItems: readonly FaqItem[] = [
  {
    question: "Do signers need a SignuDoc account?",
    answer:
      "Nope. You sign in to send documents, but your signers just click a link and sign. No account, no friction.",
  },
  {
    question: "What field types can I place on a document?",
    answer:
      "Signature, initials, date, text, and checkbox. Everything most documents need.",
  },
  {
    question: "Can I remind a signer if they are taking too long?",
    answer:
      "Yes. Hit the remind button and they get a nudge. No need to resend the whole document.",
  },
  {
    question: "What do I get when everyone finishes signing?",
    answer:
      "You get the final signed PDF plus a tamper-proof certificate. Download both in one click.",
  },
] as const;

type SecurityPillar = {
  body: string;
  iconPath: string;
  title: string;
};

const securityPillars: readonly SecurityPillar[] = [
  {
    title: "Encrypted at rest and in transit",
    body: "Documents are stored with encryption on Cloudflare's infrastructure. All connections use HTTPS with HSTS enforcement.",
    iconPath:
      "M7 11V7a5 5 0 0110 0v4M5 11h14a2 2 0 012 2v7a2 2 0 01-2 2H5a2 2 0 01-2-2v-7a2 2 0 012-2z",
  },
  {
    title: "Complete audit trail",
    body: "Every view, signature, and decline is logged with timestamps and IP addresses. Download the certificate PDF as proof.",
    iconPath:
      "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 14l2 2 4-4",
  },
  {
    title: "Secure signing links",
    body: "Each signer gets a unique cryptographic token. Links expire after 7 days and can't be guessed or reused.",
    iconPath:
      "M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71",
  },
  {
    title: "Open source",
    body: "The entire codebase is public. Inspect the security model, audit the logic, or self-host on your own infrastructure.",
    iconPath:
      "M12 2a10 10 0 1010 10A10 10 0 0012 2zM2 12h20M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10A15.3 15.3 0 0112 2z",
  },
] as const;

export function resolveLandingShellState(
  value?: string | string[] | null,
): LandingShellState {
  return resolveShellState(value, landingShellStates, "default");
}

export function LandingShell({ initialState = "default" }: LandingShellProps) {
  const resolvedInitialState = resolveLandingShellState(initialState);
  const authenticated = resolvedInitialState === "authenticated";
  const monoClassName = ibmPlexMono.className;
  const primaryHref = authenticated ? "/dashboard" : "/signup";
  const primaryLabel = authenticated ? "Go to dashboard" : "Start free";
  const secondaryLabel = "See how it works";

  return (
    <div
      className={`${archivo.className} min-h-screen bg-white text-[#000000]`}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 z-0 opacity-35"
        style={{
          backgroundImage:
            "radial-gradient(circle, #d4d4d4 0.8px, transparent 0.8px)",
          backgroundSize: "48px 48px",
        }}
      />

      <header className="relative z-10 border-b border-[#d4d4d4] bg-white/90 backdrop-blur">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-6 py-5 sm:px-8 lg:px-10">
          <LandingWordmark />

          <nav className="flex flex-wrap items-center gap-3">
            {!authenticated ? (
              <Link
                className={`${monoClassName} text-sm font-medium text-[#71717a] transition-colors hover:text-black`}
                href="/login"
              >
                Log in
              </Link>
            ) : null}
            <ActionLink
              href={primaryHref}
              monoClassName={monoClassName}
              variant="primary"
            >
              {primaryLabel}
            </ActionLink>
          </nav>
        </div>
      </header>

      <main className="relative z-10">
        <section className="overflow-hidden border-b border-[#d4d4d4]">
          <div className="mx-auto max-w-[1200px] px-6 pb-20 pt-16 sm:px-8 sm:pt-20 lg:px-10 lg:pb-24 lg:pt-24">
            <div className="relative">
              <CropMarks
                className="hidden lg:block"
                color="#e50000"
                offset={26}
                size={28}
              />
              <div className="px-0 py-4 sm:py-6 lg:px-4 lg:py-8">
                <div
                  className="mx-auto max-w-216 text-center"
                  data-animate="enter"
                >
                  <SectionMarker center monoClassName={monoClassName}>
                    Free e-signature software
                  </SectionMarker>

                  <h1
                    className="mx-auto max-w-[22ch] text-[clamp(2.2rem,4.5vw,4.2rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-black sm:max-w-[23ch] lg:max-w-[24ch] lg:leading-[1.1] lg:tracking-[-0.03em]"
                    style={{ textWrap: "balance" }}
                  >
                    Sign PDFs Online for Free. No catch.
                  </h1>

                  <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-[#71717a] sm:text-[1.15rem]">
                    Upload a PDF, drop in signature fields, and send.
                    That&apos;s it.
                  </p>

                  <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
                    <ActionLink
                      href={primaryHref}
                      monoClassName={monoClassName}
                      variant="primary"
                    >
                      {primaryLabel}
                    </ActionLink>
                    <ActionLink
                      href="#workflow"
                      monoClassName={monoClassName}
                      variant="secondary"
                    >
                      {secondaryLabel}
                    </ActionLink>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          className="border-b border-[#d4d4d4] bg-[#f7f7f8]"
          data-animate="enter"
          data-animate-delay="1"
          id="workflow"
        >
          <div className="mx-auto max-w-[1200px] px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
            <div className="mx-auto max-w-160 text-center">
              <SectionMarker center monoClassName={monoClassName}>
                How it works
              </SectionMarker>
              <h2 className="text-[clamp(2rem,4vw,3.1rem)] font-extrabold leading-[1.06] tracking-[-0.03em] text-black">
                Four steps. One signed document.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-[#71717a]">
                Upload a PDF, set the signing order, place fields, and hit send.
                Your signers don&apos;t even need an account.
              </p>
            </div>

            <div className="mt-12">
              <LandingDashboardPreview />
            </div>

            <div className="mt-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-4 lg:gap-8">
              {workflowSteps.map((step, index) => (
                <WorkflowStepInline
                  body={step.body}
                  index={index + 1}
                  key={step.title}
                  monoClassName={monoClassName}
                  title={step.title}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-[#d4d4d4]" data-animate="enter">
          <div className="mx-auto max-w-[1200px] px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
            <div className="mx-auto max-w-160 text-center">
              <SectionMarker center monoClassName={monoClassName}>
                Security
              </SectionMarker>
              <h2 className="text-[clamp(2rem,4vw,3.1rem)] font-extrabold leading-[1.06] tracking-[-0.03em] text-black">
                Your documents stay safe.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-[#71717a]">
                Every PDF is encrypted, every action is logged, and every
                signing link is cryptographically secured. The code is open
                source so you can verify it yourself.
              </p>
            </div>

            <div className="mx-auto mt-14 grid max-w-[880px] gap-4 sm:grid-cols-2">
              {securityPillars.map((pillar) => (
                <SecurityPillarCard
                  body={pillar.body}
                  iconPath={pillar.iconPath}
                  key={pillar.title}
                  title={pillar.title}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="border-b border-[#d4d4d4]" data-animate="enter">
          <div className="mx-auto max-w-[1200px] px-6 py-20 sm:px-8 lg:px-10 lg:py-24">
            <div className="mx-auto max-w-160 text-center">
              <SectionMarker center monoClassName={monoClassName}>
                Pricing
              </SectionMarker>
              <h2 className="text-[clamp(2rem,4vw,3.1rem)] font-extrabold leading-[1.06] tracking-[-0.03em] text-black">
                Free beats $120 a year.
              </h2>
              <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-[#71717a]">
                Everything below is included. Forever. For $0. See how that
                stacks up against DocuSign.
              </p>
            </div>

            <div className="mt-14">
              <ComparisonTable monoClassName={monoClassName} />
            </div>

            <div className="mt-10 flex flex-col items-center gap-4 text-center">
              <ActionLink
                href={primaryHref}
                monoClassName={monoClassName}
                variant="primary"
              >
                {primaryLabel}
              </ActionLink>
              <p
                className={`${monoClassName} text-[11px] uppercase tracking-[0.18em] text-[#71717a]`}
              >
                Your signers never need to create an account.
              </p>
            </div>

            <div className="mt-20 lg:mt-24">
              <div className="mx-auto max-w-[780px]">
                <div className="text-center">
                  <SectionMarker center monoClassName={monoClassName}>
                    FAQ
                  </SectionMarker>
                  <h3 className="text-[clamp(1.9rem,3.5vw,2.85rem)] font-extrabold leading-[1.06] tracking-[-0.03em] text-black">
                    Quick answers.
                  </h3>
                </div>
                <div className="mt-8 border-t border-[#d4d4d4]">
                  {faqItems.map((item) => (
                    <FaqRow
                      answer={item.answer}
                      key={item.question}
                      question={item.question}
                    />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        <section
          className="border-b border-[#d4d4d4] bg-[#f7f7f8]"
          data-animate="enter"
          data-animate-delay="1"
        >
          <div className="mx-auto max-w-[1200px] px-6 py-20 text-center sm:px-8 lg:px-10 lg:py-24">
            <div className="mx-auto max-w-[780px]">
              <SectionMarker center monoClassName={monoClassName}>
                Start free
              </SectionMarker>
              <h2 className="text-[clamp(2.1rem,4.5vw,3.6rem)] font-extrabold leading-[1.04] tracking-[-0.04em] text-black">
                Send your next agreement. On us.
              </h2>
              <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-[#71717a]">
                No credit card. No per-envelope fees. Just upload and send.
              </p>

              <div className="mt-10 flex flex-wrap justify-center gap-4">
                <ActionLink
                  href={primaryHref}
                  monoClassName={monoClassName}
                  variant="primary"
                >
                  {primaryLabel}
                </ActionLink>
                {!authenticated ? (
                  <ActionLink
                    href="/login"
                    monoClassName={monoClassName}
                    variant="secondary"
                  >
                    Log in
                  </ActionLink>
                ) : null}
              </div>

              <p
                className={`${monoClassName} mt-8 text-[11px] uppercase tracking-[0.18em] text-[#71717a]`}
              >
                Free • no signer account required • up to 10 signers per
                document
              </p>
            </div>
          </div>
        </section>
      </main>

      <PublicLegalFooter />
    </div>
  );
}

function LandingWordmark() {
  return (
    <Link aria-label="SignuDoc" className="flex items-center" href="/">
      <span className="text-[24px] font-extrabold tracking-[-0.035em] text-black sm:text-[27px]">
        Signu<span className="text-[#e50000]">Doc</span>
      </span>
    </Link>
  );
}

function ActionLink({
  children,
  href,
  monoClassName,
  variant,
}: {
  children: ReactNode;
  href: string;
  monoClassName: string;
  variant: "primary" | "secondary";
}) {
  const sharedClassName = `${monoClassName} inline-flex items-center justify-center border-2 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] transition-colors`;
  const variantClassName =
    variant === "primary"
      ? "border-[#e50000] bg-[#e50000] hover:border-[#c00000] hover:bg-[#c00000]"
      : "border-[#d4d4d4] bg-transparent text-black hover:border-black";
  const style = variant === "primary" ? { color: "#fff" } : undefined;

  return (
    <Link
      className={`${sharedClassName} ${variantClassName}`}
      href={href}
      style={style}
    >
      {children}
    </Link>
  );
}

function SectionMarker({
  center = false,
  children,
  monoClassName,
}: {
  center?: boolean;
  children: string;
  monoClassName: string;
}) {
  return (
    <div
      className={`mb-6 flex items-center gap-3 ${center ? "justify-center" : ""}`}
    >
      <GridDot />
      <span
        className={`${monoClassName} text-xs font-medium uppercase tracking-[0.2em] text-[#71717a]`}
      >
        {children}
      </span>
    </div>
  );
}

function CropMarks({
  className = "",
  color = "#e50000",
  offset = 0,
  size = 20,
}: {
  className?: string;
  color?: string;
  offset?: number;
  size?: number;
}) {
  return (
    <div
      className={`pointer-events-none absolute ${className}`}
      style={{ inset: offset }}
    >
      <span
        className="absolute left-0 top-0"
        style={{
          borderLeft: `2px solid ${color}`,
          borderTop: `2px solid ${color}`,
          height: size,
          width: size,
        }}
      />
      <span
        className="absolute right-0 top-0"
        style={{
          borderRight: `2px solid ${color}`,
          borderTop: `2px solid ${color}`,
          height: size,
          width: size,
        }}
      />
      <span
        className="absolute bottom-0 left-0"
        style={{
          borderBottom: `2px solid ${color}`,
          borderLeft: `2px solid ${color}`,
          height: size,
          width: size,
        }}
      />
      <span
        className="absolute bottom-0 right-0"
        style={{
          borderBottom: `2px solid ${color}`,
          borderRight: `2px solid ${color}`,
          height: size,
          width: size,
        }}
      />
    </div>
  );
}

function GridDot() {
  return (
    <span className="inline-block h-[6px] w-[6px] rounded-full bg-[#e50000]" />
  );
}

function WorkflowStepInline({
  body,
  index,
  monoClassName,
  title,
}: WorkflowStep & {
  index: number;
  monoClassName: string;
}) {
  return (
    <div className="text-center lg:text-left">
      <div className="flex justify-center lg:justify-start">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#e50000]">
          <span
            className={`${monoClassName} text-base font-bold leading-none text-white`}
          >
            {String(index).padStart(2, "0")}
          </span>
        </div>
      </div>
      <h3 className="mt-4 text-lg font-bold leading-tight tracking-[-0.02em] text-black">
        {title}
      </h3>
      <p className="mt-2 text-[15px] leading-relaxed text-[#71717a]">{body}</p>
    </div>
  );
}

function SecurityPillarCard({ body, iconPath, title }: SecurityPillar) {
  return (
    <div className="border-2 border-[#d4d4d4] bg-white px-6 py-7 text-center">
      <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-[rgba(229,0,0,0.14)] bg-[#fff8f8]">
        <svg
          className="h-[22px] w-[22px]"
          fill="none"
          stroke="#e50000"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.8"
          viewBox="0 0 24 24"
        >
          <path d={iconPath} />
        </svg>
      </div>
      <h3 className="text-base font-bold leading-tight tracking-[-0.02em] text-black">
        {title}
      </h3>
      <p className="mt-2 text-[15px] leading-relaxed text-[#71717a]">{body}</p>
    </div>
  );
}

function FaqRow({ answer, question }: FaqItem) {
  return (
    <article className="border-b border-[#d4d4d4] py-6 last:border-b-0">
      <h3 className="text-xl font-bold leading-tight tracking-[-0.03em] text-black">
        {question}
      </h3>
      <p className="mt-3 text-[15px] leading-relaxed text-[#71717a]">
        {answer}
      </p>
    </article>
  );
}

function ComparisonTable({ monoClassName }: { monoClassName: string }) {
  return (
    <div className="relative border-2 border-[#d4d4d4] bg-white">
      <CropMarks color="#e50000" size={14} />

      {/* Desktop table */}
      <div className="hidden lg:block">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th
                className={`${monoClassName} w-[35%] border-b-2 border-[#d4d4d4] px-6 py-5 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#71717a]`}
              >
                Feature
              </th>
              <th className="w-[32.5%] border-b-2 border-l border-[#d4d4d4] bg-[#fff8f8] px-6 py-5 text-center">
                <span className="text-[17px] font-bold tracking-tight text-black">
                  Signu<span className="text-[#e50000]">Doc</span>
                </span>
              </th>
              <th className="w-[32.5%] border-b-2 border-l border-[#d4d4d4] px-6 py-5 text-center">
                <span className="text-[17px] font-bold tracking-tight text-[#71717a]">
                  DocuSign
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows.map((row) => (
              <tr key={row.feature}>
                <td className="border-t border-[#d4d4d4] px-6 py-4 text-[15px] font-medium text-black">
                  {row.feature}
                </td>
                <td className="border-t border-l border-[#d4d4d4] bg-[#fff8f8] px-6 py-4 text-center">
                  <ComparisonValue advantage value={row.signudoc} />
                </td>
                <td className="border-t border-l border-[#d4d4d4] px-6 py-4 text-center text-[#71717a]">
                  <ComparisonValue value={row.docusign} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked layout */}
      <div className="lg:hidden">
        <div className="grid grid-cols-2 border-b-2 border-[#d4d4d4]">
          <div className="border-r border-[#d4d4d4] bg-[#fff8f8] px-4 py-4 text-center">
            <span className="text-[15px] font-bold tracking-tight text-black">
              Signu<span className="text-[#e50000]">Doc</span>
            </span>
          </div>
          <div className="px-4 py-4 text-center">
            <span className="text-[15px] font-bold tracking-tight text-[#71717a]">
              DocuSign
            </span>
          </div>
        </div>
        {comparisonRows.map((row) => (
          <div className="border-t border-[#d4d4d4]" key={row.feature}>
            <div
              className={`${monoClassName} px-4 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#71717a]`}
            >
              {row.feature}
            </div>
            <div className="grid grid-cols-2">
              <div className="border-r border-[#d4d4d4] bg-[#fff8f8] px-4 pb-4 text-center">
                <ComparisonValue advantage value={row.signudoc} />
              </div>
              <div className="px-4 pb-4 text-center text-[#71717a]">
                <ComparisonValue value={row.docusign} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ComparisonValue({
  advantage = false,
  value,
}: {
  advantage?: boolean;
  value: string | boolean;
}) {
  if (typeof value === "boolean") {
    return value ? <CheckIcon /> : <XIcon />;
  }

  const isStrong =
    advantage &&
    (value === "Free forever" || value === "Unlimited" || value === "Included");

  return (
    <span
      className={
        isStrong
          ? "text-[15px] font-bold text-black"
          : "text-[15px] leading-relaxed"
      }
    >
      {value}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg
      className="inline-block h-5 w-5 text-[#16a34a]"
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        clipRule="evenodd"
        d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
        fillRule="evenodd"
      />
    </svg>
  );
}

function XIcon() {
  return (
    <svg
      className="inline-block h-5 w-5 text-[#e50000]"
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        clipRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        fillRule="evenodd"
      />
    </svg>
  );
}
