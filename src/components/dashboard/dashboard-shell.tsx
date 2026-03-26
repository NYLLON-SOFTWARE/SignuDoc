"use client";

import { useState, type ChangeEvent } from "react";

import type { DashboardEnvelopeListItem } from "@/lib/envelopes";
import {
  DashboardDocumentsHeader,
  DashboardDocumentsPanel,
  dashboardStatusFilterMap,
  type DashboardFilter,
  type DashboardShellState,
} from "@/components/dashboard/dashboard-documents-surface";
import { ShellButton } from "@/components/shared/form-shell";

type DashboardShellProps = {
  envelopes?: readonly DashboardEnvelopeListItem[];
  initialState?: DashboardShellState;
};

export function DashboardShell({
  envelopes: providedEnvelopes,
  initialState = "default",
}: DashboardShellProps) {
  const [searchValue, setSearchValue] = useState("");
  const [selectedFilter, setSelectedFilter] = useState<DashboardFilter>("All");

  const envelopes =
    initialState === "empty"
      ? ([] as readonly DashboardEnvelopeListItem[])
      : (providedEnvelopes ?? []);
  const normalizedSearchValue = searchValue.trim().toLowerCase();
  const filteredEnvelopes = envelopes.filter((envelope) => {
    const matchesFilter =
      selectedFilter === "All"
        ? true
        : envelope.status === dashboardStatusFilterMap[selectedFilter];
    const matchesSearch =
      normalizedSearchValue.length === 0 ||
      envelope.title.toLowerCase().includes(normalizedSearchValue) ||
      envelope.searchableEmails.some((email) =>
        email.toLowerCase().includes(normalizedSearchValue),
      );

    return matchesFilter && matchesSearch;
  });
  const isError = initialState === "error";

  function handleSearchChange(event: ChangeEvent<HTMLInputElement>) {
    setSearchValue(event.target.value);
  }

  function handleFilterChange(filter: DashboardFilter) {
    setSelectedFilter(filter);
  }

  function handleResetFilters() {
    setSearchValue("");
    setSelectedFilter("All");
  }

  function handleRetry() {
    window.location.reload();
  }

  return (
    <div className="space-y-8">
      <DashboardDocumentsHeader />

      {initialState === "empty" ? (
        <EmptyDashboardState />
      ) : (
        <DashboardDocumentsPanel
          envelopes={envelopes}
          filteredEnvelopes={filteredEnvelopes}
          isError={isError}
          onFilterChange={handleFilterChange}
          onReset={handleResetFilters}
          onRetry={handleRetry}
          onSearchChange={handleSearchChange}
          searchValue={searchValue}
          selectedFilter={selectedFilter}
        />
      )}
    </div>
  );
}

function EmptyDashboardState() {
  return (
    <section
      className="editorial-panel p-6 sm:p-8"
      data-animate="enter"
      data-animate-delay="1"
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 border border-dashed border-(--border) bg-(--surface) px-8 py-12 text-center">
        <span className="inline-flex h-16 min-w-16 items-center justify-center border border-(--accent) bg-[#fff8f8] px-4 text-xs font-semibold uppercase tracking-[0.28em] text-(--accent)">
          PDF
        </span>
        <div className="space-y-2">
          <h2 className="text-2xl font-semibold tracking-[-0.04em] text-(--fg)">
            No documents yet
          </h2>
          <p className="text-sm leading-6 text-muted-foreground">
            Upload a PDF and send it for signatures in minutes.
          </p>
        </div>
        <ShellButton href="/envelopes/new">+ New envelope</ShellButton>
      </div>
    </section>
  );
}
