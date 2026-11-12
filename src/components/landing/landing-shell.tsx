import type { LucideIcon } from "lucide-react";
import Link from "next/link";
import {
  CheckIcon,
  ClipboardCheck,
  Globe,
  Link2,
  ShieldCheck,
  XIcon,
} from "lucide-react";

import { Brand, BrandMark } from "@/components/layout/brand";
import { PublicSessionMenu } from "@/components/layout/public-session-menu";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { LandingDashboardPreview } from "@/components/landing/dashboard-preview";
import {
  LandingSessionLoginAction,
  LandingSessionPrimaryAction,
} from "@/components/landing/landing-session-actions";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/cn";

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
  icon: LucideIcon;
  title: string;
};

const securityPillars: readonly SecurityPillar[] = [
  {
    title: "Encrypted at rest and in transit",
    body: "Documents are kept in private, encrypted storage. All connections use HTTPS with HSTS enforcement.",
    icon: ShieldCheck,
  },
  {
    title: "Complete audit trail",
    body: "Every view, signature, and decline is logged with timestamps and IP addresses. Download the certificate PDF as proof.",
    icon: ClipboardCheck,
  },
  {
    title: "Secure signing links",
    body: "Each signer gets a unique cryptographic token. Links expire after 7 days and can't be guessed or reused.",
    icon: Link2,
  },
  {
    title: "Open source",
    body: "The entire codebase is public. Inspect the security model, audit the logic, or self-host on your own infrastructure.",
    icon: Globe,
  },
];

const sectionHeadingClassName =
  "text-[clamp(1.875rem,4vw,2.75rem)] font-extrabold leading-[1.08] tracking-[-0.035em] text-(--fg)";
const sectionLeadClassName =
  "mx-auto mt-4 max-w-xl text-[1.0625rem] leading-relaxed text-(--secondary)";

export function LandingShell() {
  return (
    <div className="flex min-h-screen flex-col text-(--fg)">
      <header className="sticky top-0 z-30 bg-[rgba(243,244,248,0.86)] backdrop-blur-md">
        <div className="page-width flex items-center justify-between gap-3 py-3 sm:py-4">
          <Brand href="/" />

          <PublicSessionMenu>
            <nav
              aria-label="Public navigation"
              className="flex items-center gap-1 sm:gap-2"
            >
              <Link
                className={cn(
                  buttonVariants({ size: "sm", variant: "ghost" }),
                  "px-3 sm:px-4",
                )}
                href="/login"
                prefetch
              >
                Log in
              </Link>
              <Link
                className={buttonVariants({ size: "sm" })}
                href="/signup"
                prefetch
              >
                Start free
              </Link>
            </nav>
          </PublicSessionMenu>
        </div>
      </header>

      <main className="flex-1">
        <section className="page-width pb-14 pt-12 sm:pt-16 lg:pb-20 lg:pt-20">
          <div
            className="mx-auto max-w-[52rem] text-center"
            data-animate="enter"
          >
            <SectionMarker>Free e-signature software</SectionMarker>

            <h1 className="mx-auto max-w-[18ch] text-[clamp(2.375rem,6vw,4.25rem)] font-extrabold leading-[1.04] tracking-[-0.045em] text-(--fg)">
              Sign PDFs Online for Free.{" "}
              <span className="text-(--accent)">No catch.</span>
            </h1>

            <p className="mx-auto mt-5 max-w-xl text-lg leading-relaxed text-(--secondary) sm:text-[1.1875rem]">
              Upload a PDF, drop in signature fields, and send. That&apos;s it.
            </p>

            <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
              <LandingSessionPrimaryAction />
              <Link
                className={buttonVariants({ size: "lg", variant: "outline" })}
                href="#workflow"
              >
                See how it works
              </Link>
            </div>
          </div>

          <div
            className="mt-12 sm:mt-16"
            data-animate="enter"
            data-animate-delay="1"
          >
            <LandingDashboardPreview />
          </div>
        </section>

        <section className="scroll-mt-20 py-14 lg:py-20" id="workflow">
          <div className="page-width">
            <div className="mx-auto max-w-[40rem] text-center">
              <SectionMarker>How it works</SectionMarker>
              <h2 className={sectionHeadingClassName}>
                Four steps. One signed document.
              </h2>
              <p className={sectionLeadClassName}>
                Upload a PDF, set the signing order, place fields, and hit send.
                Your signers don&apos;t even need an account.
              </p>
            </div>

            <ol className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {workflowSteps.map((step, index) => (
                <li className="panel p-6" key={step.title}>
                  <span
                    aria-hidden="true"
                    className="inline-flex size-10 items-center justify-center rounded-xl bg-(--accent-soft) text-[0.9375rem] font-extrabold text-(--accent-ink)"
                  >
                    {index + 1}
                  </span>
                  <h3 className="mt-4 text-lg font-extrabold leading-tight tracking-[-0.02em] text-(--fg)">
                    {step.title}
                  </h3>
                  <p className="mt-2 text-[0.9375rem] leading-relaxed text-(--secondary)">
                    {step.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section className="py-14 lg:py-20">
          <div className="page-width">
            <div className="mx-auto max-w-[40rem] text-center">
              <SectionMarker>Security</SectionMarker>
              <h2 className={sectionHeadingClassName}>
                Your documents stay safe.
              </h2>
              <p className={sectionLeadClassName}>
                Every PDF is encrypted, every action is logged, and every
                signing link is cryptographically secured. The code is open
                source so you can verify it yourself.
              </p>
            </div>

            <div className="mx-auto mt-10 grid max-w-[60rem] gap-4 sm:grid-cols-2">
              {securityPillars.map((pillar) => (
                <SecurityPillarCard
                  body={pillar.body}
                  icon={pillar.icon}
                  key={pillar.title}
                  title={pillar.title}
                />
              ))}
            </div>
          </div>
        </section>

        <section className="py-14 lg:py-20">
          <div className="page-width">
            <div className="mx-auto max-w-[40rem] text-center">
              <SectionMarker>Pricing</SectionMarker>
              <h2 className={sectionHeadingClassName}>
                Free beats $120 a year.
              </h2>
              <p className={sectionLeadClassName}>
                Everything below is included. Forever. For $0. See how that
                stacks up against DocuSign.
              </p>
            </div>

            <div className="mx-auto mt-10 max-w-[60rem]">
              <ComparisonTable />
            </div>

            <div className="mt-8 flex flex-col items-center gap-3 text-center">
              <LandingSessionPrimaryAction />
              <p className="text-sm text-(--tertiary)">
                Your signers never need to create an account.
              </p>
            </div>
          </div>
        </section>

        <section className="py-14 lg:py-20">
          <div className="page-width">
            <div className="mx-auto max-w-[48rem]">
              <div className="text-center">
                <SectionMarker>FAQ</SectionMarker>
                <h2 className={sectionHeadingClassName}>Quick answers.</h2>
              </div>
              <div className="mt-8 space-y-3">
                {faqItems.map((item) => (
                  <article
                    className="panel px-6 py-5 sm:px-7"
                    key={item.question}
                  >
                    <h3 className="text-lg font-extrabold leading-snug tracking-[-0.02em] text-(--fg)">
                      {item.question}
                    </h3>
                    <p className="mt-2 text-[0.9375rem] leading-relaxed text-(--secondary)">
                      {item.answer}
                    </p>
                  </article>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="page-width pb-10 pt-6 lg:pb-14">
          <div className="rounded-[2rem] bg-(--accent) px-6 py-14 text-center sm:px-10 lg:py-20">
            <div className="mx-auto max-w-[44rem]">
              <p className="text-sm font-semibold text-white/80">Start free</p>
              <h2 className="mt-3 text-[clamp(2rem,4.5vw,3.25rem)] font-extrabold leading-[1.06] tracking-[-0.04em] text-white">
                Send your next agreement. On us.
              </h2>
              <p className="mx-auto mt-4 max-w-xl text-[1.0625rem] leading-relaxed text-white/85">
                No credit card. No per-envelope fees. Just upload and send.
              </p>

              <div className="mt-8 flex flex-wrap justify-center gap-3">
                <LandingSessionPrimaryAction tone="inverse" />
                <LandingSessionLoginAction tone="inverse" />
              </div>

              <p className="mt-7 text-sm text-white/75">
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

function SectionMarker({ children }: { children: string }) {
  return (
    <p className="mb-5 flex justify-center">
      <span className="pill pill-accent px-3.5 py-1 text-[0.8125rem]">
        {children}
      </span>
    </p>
  );
}

function SecurityPillarCard({ body, icon: Icon, title }: SecurityPillar) {
  return (
    <div className="panel flex gap-4 p-6">
      <span
        aria-hidden="true"
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-(--accent-soft) text-(--accent)"
      >
        <Icon className="size-5" strokeWidth={2} />
      </span>
      <div>
        <h3 className="text-[1.0625rem] font-extrabold leading-tight tracking-[-0.02em] text-(--fg)">
          {title}
        </h3>
        <p className="mt-1.5 text-[0.9375rem] leading-relaxed text-(--secondary)">
          {body}
        </p>
      </div>
    </div>
  );
}

function ComparisonTable() {
  return (
    <div className="panel overflow-hidden">
      {/* Desktop table */}
      <div className="hidden p-3 sm:block">
        <table className="w-full border-separate border-spacing-0 text-left">
          <thead>
            <tr>
              <th className="w-[36%] px-5 py-4 text-[0.8125rem] font-semibold text-(--tertiary)">
                Feature
              </th>
              <th className="w-[32%] rounded-t-2xl bg-(--accent-softer) px-5 py-4 text-center">
                <span className="inline-flex items-center gap-2 text-[1.0625rem] font-extrabold tracking-[-0.02em] text-(--fg)">
                  <BrandMark className="size-6 rounded-[0.5rem]" />
                  SignuDoc
                </span>
              </th>
              <th className="w-[32%] px-5 py-4 text-center">
                <span className="text-[1.0625rem] font-bold tracking-[-0.02em] text-(--tertiary)">
                  DocuSign
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {comparisonRows.map((row, index) => (
              <tr key={row.feature}>
                <td className="border-t border-(--border) px-5 py-4 text-[0.9375rem] font-semibold text-(--fg)">
                  {row.feature}
                </td>
                <td
                  className={cn(
                    "border-t border-[rgba(83,64,214,0.12)] bg-(--accent-softer) px-5 py-4 text-center",
                    index === comparisonRows.length - 1 && "rounded-b-2xl",
                  )}
                >
                  <ComparisonValue advantage value={row.signudoc} />
                </td>
                <td className="border-t border-(--border) px-5 py-4 text-center text-(--secondary)">
                  <ComparisonValue value={row.docusign} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Mobile stacked layout */}
      <div className="space-y-3 p-4 sm:hidden">
        {comparisonRows.map((row) => (
          <div className="well overflow-hidden" key={row.feature}>
            <p className="px-4 pb-2 pt-3.5 text-[0.8125rem] font-semibold text-(--tertiary)">
              {row.feature}
            </p>
            <ComparisonMobileRow
              advantage
              label="SignuDoc"
              value={row.signudoc}
            />
            <ComparisonMobileRow label="DocuSign" value={row.docusign} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ComparisonMobileRow({
  advantage = false,
  label,
  value,
}: {
  advantage?: boolean;
  label: string;
  value: string | boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-between gap-4 px-4 py-3",
        advantage ? "bg-(--accent-softer)" : "text-(--secondary)",
      )}
    >
      <span
        className={cn(
          "text-sm",
          advantage ? "font-extrabold text-(--fg)" : "font-semibold",
        )}
      >
        {label}
      </span>
      <span className="max-w-[58%] text-right">
        <ComparisonValue advantage={advantage} value={value} />
      </span>
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
    return value ? (
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-(--success-soft) text-(--success)">
        <CheckIcon aria-hidden="true" className="size-4" strokeWidth={3} />
        <span className="sr-only">Included</span>
      </span>
    ) : (
      <span className="inline-flex size-7 items-center justify-center rounded-full bg-(--danger-soft) text-(--danger)">
        <XIcon aria-hidden="true" className="size-4" strokeWidth={3} />
        <span className="sr-only">Not included</span>
      </span>
    );
  }

  return (
    <span
      className={cn(
        "text-[0.9375rem] leading-relaxed",
        advantage && "font-extrabold text-(--accent-ink)",
      )}
    >
      {value}
    </span>
  );
}
