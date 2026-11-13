import {
  DashboardDocumentsHeader,
  DashboardDocumentsPanel,
  type DashboardFilter,
} from "@/components/dashboard/dashboard-documents-surface";
import { Brand } from "@/components/layout/brand";
import { primaryNavItems } from "@/components/layout/nav-items";
import { cn } from "@/lib/cn";
import type { DashboardEnvelopeListItem } from "@/lib/envelopes";

const previewUser = {
  initials: "AR",
} as const;

const previewFilter: DashboardFilter = "All";

const previewEnvelopes: readonly DashboardEnvelopeListItem[] = [
  {
    contextLine: "2 signers · 6 fields placed",
    createdAtLabel: "Mar 15, 2026",
    id: "preview-draft",
    searchableEmails: ["ops@northline.example", "legal@riverbank.example"],
    status: "draft",
    statusLabel: "Draft",
    title: "Master Services Agreement",
  },
  {
    contextLine: "Sent to: counsel@oakline.example, finance@aster.example",
    createdAtLabel: "Mar 10, 2026",
    id: "preview-completed",
    searchableEmails: ["counsel@oakline.example", "finance@aster.example"],
    status: "completed",
    statusLabel: "Completed",
    title: "Independent Contractor Agreement",
  },
  {
    contextLine: "Waiting on: team@harbor.example",
    createdAtLabel: "Mar 8, 2026",
    id: "preview-sent",
    searchableEmails: ["team@harbor.example"],
    status: "sent",
    statusLabel: "1 of 2 signed",
    title: "NDA - Product Demo",
  },
  {
    contextLine: "Voided on Mar 10, 2026",
    createdAtLabel: "Mar 8, 2026",
    id: "preview-voided",
    searchableEmails: ["legal@atlas.example"],
    status: "voided",
    statusLabel: "Voided",
    title: "Supplier Terms - Atlas",
  },
  {
    contextLine: "Declined by: arivera@samplemail.example",
    createdAtLabel: "Feb 27, 2026",
    id: "preview-declined",
    searchableEmails: ["arivera@samplemail.example"],
    status: "declined",
    statusLabel: "Declined",
    title: "Offer Letter - A. Rivera",
  },
] as const;

export function LandingDashboardPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-[1.75rem] bg-(--page) shadow-(--shadow-soft) ring-1 ring-[rgba(28,29,43,0.06)]"
    >
      <div className="max-h-[46rem] overflow-hidden px-4 pb-6 sm:px-7">
        <div className="flex items-center justify-between gap-4 py-4">
          <div className="flex min-w-0 items-center gap-7">
            <Brand href="/" />
            <div className="hidden items-center gap-1 md:flex">
              {primaryNavItems.map((item) => (
                <span
                  className={cn(
                    "inline-flex min-h-9 items-center rounded-[0.625rem] px-3.5 text-sm",
                    item.href === "/dashboard"
                      ? "bg-white font-bold text-(--fg) shadow-(--shadow-xs)"
                      : "font-semibold text-(--secondary)",
                  )}
                  key={item.href}
                >
                  {item.label}
                </span>
              ))}
            </div>
          </div>
          <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[#ffd9c2] text-[0.8125rem] font-bold text-[#7a3412]">
            {previewUser.initials}
          </span>
        </div>

        <div className="space-y-5">
          <DashboardDocumentsHeader interactive={false} />
          <DashboardDocumentsPanel
            envelopes={previewEnvelopes}
            filteredEnvelopes={previewEnvelopes}
            interactive={false}
            searchValue=""
            selectedFilter={previewFilter}
          />
        </div>
      </div>
    </div>
  );
}
