import { PanelLeftIcon, type LucideIcon } from "lucide-react";

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
  email: "alex@studiolane.example",
  name: "Alex Rowan",
} as const;

const previewFilter: DashboardFilter = "All";

const previewEnvelopes: readonly DashboardEnvelopeListItem[] = [
  {
    contextLine: "2 signers · 6 fields placed",
    createdAtLabel: "Mar 15, 2026",
    id: "preview-draft",
    searchableEmails: ["ops@northline.example", "legal@riverbank.example"],
    status: "draft",
    title: "Master Services Agreement",
  },
  {
    contextLine: "Sent to: counsel@oakline.example, finance@aster.example",
    createdAtLabel: "Mar 10, 2026",
    id: "preview-completed",
    searchableEmails: ["counsel@oakline.example", "finance@aster.example"],
    status: "completed",
    title: "Independent Contractor Agreement",
  },
  {
    contextLine: "Waiting on: team@harbor.example",
    createdAtLabel: "Mar 8, 2026",
    id: "preview-sent",
    searchableEmails: ["team@harbor.example"],
    status: "sent",
    title: "NDA - Product Demo",
  },
  {
    contextLine: "Voided on Mar 10, 2026",
    createdAtLabel: "Mar 8, 2026",
    id: "preview-voided",
    searchableEmails: ["legal@atlas.example"],
    status: "voided",
    title: "Supplier Terms - Atlas",
  },
  {
    contextLine: "Declined by: arivera@samplemail.example",
    createdAtLabel: "Feb 27, 2026",
    id: "preview-declined",
    searchableEmails: ["arivera@samplemail.example"],
    status: "declined",
    title: "Offer Letter - A. Rivera",
  },
] as const;

export function LandingDashboardPreview() {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden border border-[#d4d4d4] bg-white"
    >
      <div className="hidden md:block">
        <div className="h-[980px] overflow-hidden lg:h-[1040px]">
          <div className="grid h-full grid-cols-[336px_minmax(0,1fr)]">
            <aside className="flex h-full flex-col border-r border-(--border) bg-white">
              <div className="flex items-center justify-between gap-3 border-b border-(--border) bg-white px-4 py-5">
                <Brand href="/" />
                <StaticSidebarTrigger />
              </div>

              <div className="flex-1 bg-white px-2 py-5">
                <div className="px-2">
                  <p className="section-eyebrow px-2 text-(--tertiary)">
                    Workspace
                  </p>

                  <div className="mt-4 space-y-1">
                    {primaryNavItems.map((item) => (
                      <StaticNavItem
                        active={item.href === "/dashboard"}
                        key={item.href}
                        label={item.label}
                        Icon={item.icon}
                      />
                    ))}
                  </div>
                </div>
              </div>

              <div className="border-t border-(--border) bg-white px-3 py-4">
                <StaticUserCard
                  email={previewUser.email}
                  name={previewUser.name}
                />
              </div>
            </aside>

            <div className="bg-transparent">
              <PreviewDocumentsWorkspace />
            </div>
          </div>
        </div>
      </div>

      <div className="md:hidden">
        <div className="h-[1240px] overflow-hidden bg-white">
          <header className="border-b border-(--border) bg-white">
            <div className="flex items-center justify-between gap-3 px-4 py-4">
              <div className="flex items-center gap-3">
                <Brand href="/" />
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                    Sender app
                  </p>
                  <p className="text-sm font-semibold text-(--fg)">Documents</p>
                </div>
              </div>

              <StaticSidebarTrigger mobile />
            </div>
          </header>

          <PreviewDocumentsWorkspace />
        </div>
      </div>
    </div>
  );
}

function PreviewDocumentsWorkspace() {
  return (
    <main className="flex-1 px-4 py-5 sm:px-6 sm:py-7 lg:px-8 xl:px-10">
      <div className="mx-auto w-full max-w-[1080px]">
        <div className="space-y-8">
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
    </main>
  );
}

function StaticSidebarTrigger({ mobile = false }: { mobile?: boolean }) {
  return (
    <div
      className={cn(
        "inline-flex items-center justify-center rounded-none border border-(--border) bg-white",
        mobile ? "size-11 text-(--fg)" : "size-10 text-muted-foreground",
      )}
    >
      <PanelLeftIcon className="size-5" />
    </div>
  );
}

function StaticNavItem({
  active,
  Icon,
  label,
}: {
  active: boolean;
  Icon: LucideIcon;
  label: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-12 items-center gap-3 rounded-none border px-3.5 py-2 text-[0.95rem] font-medium",
        active
          ? "border-(--border) bg-[#f7f7f8] text-(--fg)"
          : "border-transparent text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "inline-flex size-9 shrink-0 items-center justify-center rounded-none",
          active
            ? "bg-[#fff8f8] text-(--accent)"
            : "bg-[#f7f7f8] text-muted-foreground",
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="truncate">{label}</span>
    </div>
  );
}

function StaticUserCard({ email, name }: { email: string; name: string }) {
  return (
    <div className="flex items-center gap-3 rounded-none border border-(--border) bg-white px-3 py-3 text-left text-(--fg)">
      <div className="inline-flex size-10 items-center justify-center rounded-none bg-[#fff8f8] text-sm font-semibold text-(--accent)">
        {getInitials(name)}
      </div>

      <div className="min-w-0">
        <p className="truncate text-sm font-semibold text-(--fg)">{name}</p>
        <p className="truncate text-xs text-(--tertiary)">{email}</p>
      </div>
    </div>
  );
}

function getInitials(name: string) {
  const segments = name
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (segments.length === 0) {
    return "SU";
  }

  return segments.map((segment) => segment[0]?.toUpperCase() ?? "").join("");
}
