import type { ReactNode } from "react";

type PageHeaderProps = {
  action?: ReactNode;
  description?: string;
  title: string;
};

/** The white card that opens a page: its title, one line about it, one action. */
export function PageHeader({ action, description, title }: PageHeaderProps) {
  return (
    <div
      className="panel flex flex-col gap-5 px-6 py-6 sm:flex-row sm:items-center sm:justify-between sm:px-8 sm:py-7"
      data-animate="enter"
    >
      <div className="min-w-0 space-y-1.5">
        <h1 className="text-[clamp(1.625rem,3vw,2rem)] font-extrabold leading-[1.15] tracking-[-0.03em] text-(--fg)">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-[0.9375rem] leading-6 text-(--secondary)">
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
