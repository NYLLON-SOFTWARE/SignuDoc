import type { ReactNode } from "react";

type PageHeaderProps = {
  action?: ReactNode;
  description?: string;
  eyebrow?: string;
  title: string;
};

export function PageHeader({
  action,
  description,
  eyebrow = "Workspace",
  title,
}: PageHeaderProps) {
  return (
    <div
      className="flex flex-col gap-5 border-b border-(--border) pb-6 sm:flex-row sm:items-end sm:justify-between"
      data-animate="enter"
    >
      <div className="space-y-3">
        <div className="space-y-2">
          <p className="section-eyebrow">{eyebrow}</p>
          <h1 className="text-[clamp(2.4rem,4.8vw,4rem)] font-extrabold leading-[1.02] tracking-[-0.045em] text-black">
            {title}
          </h1>
          {description ? (
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground sm:text-base">
              {description}
            </p>
          ) : null}
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
