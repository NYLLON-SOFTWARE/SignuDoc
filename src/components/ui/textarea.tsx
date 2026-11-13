import * as React from "react";

import { cn } from "@/lib/cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-28 w-full rounded-xl border-[1.5px] border-[var(--border-strong)] bg-[var(--paper)] px-4 py-3 text-sm text-[var(--fg)] transition-[border-color,box-shadow] outline-none placeholder:text-[var(--placeholder)] hover:border-[var(--border-hover)] focus-visible:border-[var(--accent)] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-[var(--surface)] disabled:text-[var(--secondary)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
