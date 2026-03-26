import * as React from "react";

import { cn } from "@/lib/cn";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "min-h-12 w-full min-w-0 rounded-none border border-input bg-[var(--paper-raised)] px-4 py-3 text-sm text-[var(--fg)] transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-[var(--placeholder)] focus-visible:border-[var(--fg)] focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-[rgba(247,247,248,0.92)] disabled:text-[var(--secondary)] aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
