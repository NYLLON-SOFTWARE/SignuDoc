import Link from "next/link";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";

type StatusPanelProps = {
  action?: {
    href: string;
    label: string;
  };
  description: string;
  footer?: ReactNode;
  eyebrow?: string;
  title: string;
  tone?: "error" | "loading" | "neutral";
};

const badgeStyles: Record<NonNullable<StatusPanelProps["tone"]>, string> = {
  neutral: "bg-[rgba(17,17,17,0.06)] text-muted-foreground",
  loading: "bg-[rgba(37,99,235,0.12)] text-chart-1",
  error: "bg-[rgba(255,0,51,0.1)] text-(--accent)",
};

export function StatusPanel({
  action,
  description,
  footer,
  eyebrow,
  title,
  tone = "neutral",
}: StatusPanelProps) {
  return (
    <section className="editorial-panel space-y-4 p-6 sm:p-8">
      <Badge
        variant="secondary"
        className={`inline-flex rounded-none px-3 py-1 [font-family:var(--font-mono)] uppercase tracking-[0.18em] ${badgeStyles[tone]}`}
      >
        {eyebrow ??
          (tone === "error"
            ? "Error"
            : tone === "loading"
              ? "Loading"
              : "Ready")}
      </Badge>
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-[-0.03em] text-(--fg)">
          {title}
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {tone === "loading" ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-3 w-full max-w-xl rounded-none bg-(--surface)" />
          <Skeleton className="h-3 w-4/5 rounded-none bg-(--surface)" />
          <Skeleton className="h-3 w-2/3 rounded-none bg-(--surface)" />
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        {action ? (
          <Button asChild>
            <Link href={action.href}>{action.label}</Link>
          </Button>
        ) : null}
        {footer}
      </div>
    </section>
  );
}
