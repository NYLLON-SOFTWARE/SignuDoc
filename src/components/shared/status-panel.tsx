import Link from "next/link";
import type { ReactNode } from "react";

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
  neutral: "pill-neutral",
  loading: "pill-accent",
  error: "pill-danger",
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
    <section className="panel space-y-4 p-6 sm:p-8">
      <span className={`pill ${badgeStyles[tone]}`}>
        {eyebrow ??
          (tone === "error"
            ? "Error"
            : tone === "loading"
              ? "Loading"
              : "Ready")}
      </span>
      <div className="space-y-2">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          {title}
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {description}
        </p>
      </div>
      {tone === "loading" ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-3 w-full max-w-xl rounded-full bg-(--surface-strong)" />
          <Skeleton className="h-3 w-4/5 rounded-full bg-(--surface-strong)" />
          <Skeleton className="h-3 w-2/3 rounded-full bg-(--surface-strong)" />
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
