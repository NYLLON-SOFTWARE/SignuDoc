import * as React from "react";

import { cn } from "@/lib/cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-28 w-full rounded-[1.35rem] border border-input bg-[var(--paper-raised)] px-4 py-3 text-sm text-[var(--fg)] transition-colors outline-none placeholder:text-[var(--placeholder)] focus-visible:border-[var(--border-strong)] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:bg-[rgba(248,244,238,0.9)] disabled:text-[var(--secondary)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
