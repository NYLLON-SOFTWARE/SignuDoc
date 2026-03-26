import Link from "next/link";
import type { ChangeEventHandler } from "react";

import { cn } from "@/lib/cn";
import type { DashboardEnvelopeListItem } from "@/lib/envelopes";
import { ShellButton, StaticShellButton } from "@/components/shared/form-shell";
import { PageHeader } from "@/components/shared/page-header";

export type DashboardShellState = "default" | "empty" | "error";

export type DashboardFilter =
  | "All"
  | "Draft"
  | "Sent"
  | "Completed"
  | "Declined"
  | "Voided";

type EnvelopeStatus = "draft" | "sent" | "completed" | "declined" | "voided";

export const filterOptions: readonly DashboardFilter[] = [
  "All",
  "Draft",
  "Sent",
  "Completed",
  "Declined",
  "Voided",
];

export const dashboardStatusFilterMap: Record<
  Exclude<DashboardFilter, "All">,
  EnvelopeStatus
> = {
  Completed: "completed",
  Declined: "declined",
  Draft: "draft",
  Sent: "sent",
  Voided: "voided",
};

const documentsDescription =
  "Track drafts, sent envelopes, and completed agreements in one place.";

const statusLabelMap: Record<EnvelopeStatus, string> = {
  completed: "Completed",
  declined: "Declined",
  draft: "Draft",
  sent: "Sent",
  voided: "Voided",
};

const statusBadgeClasses: Record<EnvelopeStatus, string> = {
  completed: "bg-[rgba(5,150,105,0.12)] text-chart-4",
  declined: "bg-[rgba(255,0,51,0.1)] text-(--accent)",
  draft: "bg-[rgba(17,17,17,0.06)] text-muted-foreground",
  sent: "bg-[rgba(37,99,235,0.12)] text-chart-1",
  voided: "bg-[rgba(17,17,17,0.06)] text-(--tertiary)",
};

type DashboardDocumentsHeaderProps = {
  interactive?: boolean;
};

type DashboardDocumentsPanelProps = {
  envelopes: readonly DashboardEnvelopeListItem[];
  filteredEnvelopes: readonly DashboardEnvelopeListItem[];
  interactive?: boolean;
  isError?: boolean;
  onFilterChange?: (filter: DashboardFilter) => void;
  onReset?: () => void;
  onRetry?: () => void;
  onSearchChange?: ChangeEventHandler<HTMLInputElement>;
  searchValue: string;
  selectedFilter: DashboardFilter;
};

type EnvelopeListProps = {
  envelopes: readonly DashboardEnvelopeListItem[];
  interactive: boolean;
};

type NoResultsStateProps = {
  interactive: boolean;
  onReset?: () => void;
};

type ErrorBannerProps = {
  interactive: boolean;
  onRetry?: () => void;
};

export function DashboardDocumentsHeader({
  interactive = true,
}: DashboardDocumentsHeaderProps) {
  return (
    <PageHeader
      action={
        interactive ? (
          <ShellButton href="/envelopes/new">New envelope</ShellButton>
        ) : (
          <StaticShellButton>New envelope</StaticShellButton>
        )
      }
      description={documentsDescription}
      eyebrow="Sender workspace"
      title="Documents"
    />
  );
}

export function DashboardDocumentsPanel({
  envelopes,
  filteredEnvelopes,
  interactive = true,
  isError = false,
  onFilterChange,
  onReset,
  onRetry,
  onSearchChange,
  searchValue,
  selectedFilter,
}: DashboardDocumentsPanelProps) {
  const hasSeededEnvelopes = envelopes.length > 0;

  return (
    <section
      className="editorial-panel overflow-hidden p-4 sm:p-6"
      data-animate="enter"
      data-animate-delay="1"
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-4 border-b border-(--border) pb-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="section-eyebrow">Filter documents</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                Search by title or signer email, then narrow by status.
              </p>
            </div>
            {!isError && hasSeededEnvelopes ? (
              <p className="text-sm text-muted-foreground">
                Showing {filteredEnvelopes.length} of {envelopes.length}{" "}
                envelopes
              </p>
            ) : null}
          </div>

          <input
            aria-label="Search by title or email..."
            className="min-h-12 w-full rounded-none border border-(--border) bg-white px-4 text-sm text-(--fg) outline-none placeholder:text-(--placeholder)"
            onChange={interactive ? onSearchChange : undefined}
            placeholder="Search by title or email..."
            readOnly={!interactive}
            tabIndex={interactive ? undefined : -1}
            type="search"
            value={searchValue}
          />

          <div className="flex flex-wrap gap-2">
            {filterOptions.map((filter) => {
              const isActive = filter === selectedFilter;
              const filterClassName = cn(
                "inline-flex min-h-10 items-center rounded-none border px-4 [font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.18em] transition",
                isActive
                  ? "border-(--accent) bg-(--accent) text-white"
                  : "border-(--border) bg-white text-muted-foreground hover:border-black hover:bg-white hover:text-(--fg)",
              );

              if (!interactive) {
                return (
                  <span
                    aria-pressed={isActive}
                    className={filterClassName}
                    key={filter}
                  >
                    {filter}
                  </span>
                );
              }

              return (
                <button
                  aria-pressed={isActive}
                  className={filterClassName}
                  key={filter}
                  onClick={() => onFilterChange?.(filter)}
                  type="button"
                >
                  {filter}
                </button>
              );
            })}
          </div>
        </div>

        {isError ? (
          <ErrorBanner interactive={interactive} onRetry={onRetry} />
        ) : null}

        {filteredEnvelopes.length > 0 ? (
          <EnvelopeList
            envelopes={filteredEnvelopes}
            interactive={interactive}
          />
        ) : hasSeededEnvelopes ? (
          <NoResultsState interactive={interactive} onReset={onReset} />
        ) : null}
      </div>
    </section>
  );
}

function ErrorBanner({ interactive, onRetry }: ErrorBannerProps) {
  return (
    <div
      className="flex flex-col gap-4 border border-[rgba(229,0,0,0.2)] bg-[#fff8f8] px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
      role="alert"
    >
      <p className="text-sm font-medium text-(--fg)">
        We couldn&apos;t load your documents. Please try again.
      </p>
      {interactive ? (
        <ShellButton onClick={onRetry} variant="secondary">
          Retry
        </ShellButton>
      ) : (
        <StaticShellButton variant="secondary">Retry</StaticShellButton>
      )}
    </div>
  );
}

function EnvelopeList({ envelopes, interactive }: EnvelopeListProps) {
  return (
    <ul className="overflow-hidden border border-(--border) bg-white">
      {envelopes.map((envelope) => (
        <li
          className="border-b border-(--border) last:border-b-0"
          key={envelope.id}
        >
          <EnvelopeRow envelope={envelope} interactive={interactive} />
        </li>
      ))}
    </ul>
  );
}

function EnvelopeRow({
  envelope,
  interactive,
}: {
  envelope: DashboardEnvelopeListItem;
  interactive: boolean;
}) {
  const content = (
    <>
      <div className="space-y-2">
        <div className="flex flex-wrap items-start gap-3">
          <h2
            className={`text-lg font-semibold tracking-[-0.03em] ${
              envelope.status === "voided"
                ? "text-muted-foreground line-through"
                : "text-(--fg)"
            }`}
          >
            {envelope.title}
          </h2>
        </div>
        <p className="text-sm leading-6 text-muted-foreground">
          {envelope.contextLine}
        </p>
        <p className="text-sm text-(--tertiary)">
          Created {envelope.createdAtLabel}
        </p>
      </div>

      <span
        aria-label={`Status: ${statusLabelMap[envelope.status]}`}
        className={`inline-flex min-h-10 items-center justify-center rounded-none px-4 [font-family:var(--font-mono)] text-[0.72rem] font-semibold uppercase tracking-[0.18em] ${statusBadgeClasses[envelope.status]}`}
      >
        {statusLabelMap[envelope.status]}
      </span>
    </>
  );

  if (!interactive) {
    return (
      <div className="grid gap-4 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-6">
        {content}
      </div>
    );
  }

  return (
    <Link
      className="grid gap-4 px-5 py-5 transition hover:bg-[#f7f7f8] sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:px-6"
      href={`/envelopes/${envelope.id}`}
    >
      {content}
    </Link>
  );
}

function NoResultsState({ interactive, onReset }: NoResultsStateProps) {
  return (
    <div className="border border-dashed border-(--border) bg-(--surface) px-6 py-10 text-center">
      <div className="mx-auto max-w-md space-y-3">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          No documents match your search
        </h2>
        <p className="text-sm leading-6 text-muted-foreground">
          Try a different title, signer email, or status filter.
        </p>
        <div className="flex justify-center">
          {interactive ? (
            <ShellButton onClick={onReset} variant="secondary">
              Reset filters
            </ShellButton>
          ) : (
            <StaticShellButton variant="secondary">
              Reset filters
            </StaticShellButton>
          )}
        </div>
      </div>
    </div>
  );
}
