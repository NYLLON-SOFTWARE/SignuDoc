"use client";

import { PlusIcon } from "lucide-react";
import { useState, type ChangeEvent } from "react";

import type { DashboardEnvelopeListItem } from "@/lib/envelopes";
import {
  DashboardDocumentsHeader,
  DashboardDocumentsPanel,
  dashboardStatusFilterMap,
  type DashboardFilter,
  type DashboardShellState,
} from "@/components/dashboard/dashboard-documents-surface";
import { DocumentThumbnail } from "@/components/shared/document-thumbnail";
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
    <div className="space-y-5">
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
      className="panel px-6 py-14 sm:py-20"
      data-animate="enter"
      data-animate-delay="1"
    >
      <div className="mx-auto flex max-w-md flex-col items-center gap-5 text-center">
        <span className="flex h-28 items-center justify-center">
          <DocumentThumbnail title="" />
        </span>
        <div className="space-y-2">
          <h2 className="text-2xl font-extrabold tracking-[-0.03em] text-(--fg)">
            No documents yet
          </h2>
          <p className="text-[0.9375rem] leading-6 text-(--secondary)">
            Upload a PDF and send it for signatures in minutes.
          </p>
        </div>
        <ShellButton href="/envelopes/new">
          <PlusIcon
            aria-hidden="true"
            className="size-[1.125rem]"
            strokeWidth={2.4}
          />
          New envelope
        </ShellButton>
      </div>
    </section>
  );
}
