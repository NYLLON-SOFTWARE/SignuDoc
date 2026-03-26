import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";

import { cn } from "@/lib/cn";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[0.9rem] border border-transparent bg-clip-padding text-sm font-semibold whitespace-nowrap tracking-[-0.02em] transition-all outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:translate-y-px disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "border-primary bg-primary text-white [color:#fff] shadow-none hover:border-[var(--accent-hover)] hover:bg-[var(--accent-hover)] hover:text-white hover:[color:#fff]",
        outline:
          "border-[var(--border)] bg-[rgba(255,255,255,0.92)] text-card-foreground shadow-none hover:border-[var(--fg)] hover:bg-[var(--paper-raised)]",
        secondary:
          "border-[var(--border)] bg-secondary text-secondary-foreground hover:bg-[var(--surface-strong)]",
        ghost:
          "bg-transparent text-[var(--secondary)] shadow-none hover:bg-[var(--hover)] hover:text-[var(--fg)]",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default:
          "min-h-11 gap-2 px-5 has-data-[icon=inline-end]:pr-4 has-data-[icon=inline-start]:pl-4",
        xs: "min-h-8 gap-1 rounded-full px-3 text-xs [&_svg:not([class*='size-'])]:size-3",
        sm: "min-h-10 gap-1.5 rounded-full px-4 text-sm [&_svg:not([class*='size-'])]:size-3.5",
        lg: "min-h-12 gap-2 px-6 text-base",
        icon: "size-11",
        "icon-xs": "size-8 rounded-full [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-10 rounded-full [&_svg:not([class*='size-'])]:size-4",
        "icon-lg": "size-12 rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  style,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot.Root : "button";
  const resolvedStyle =
    variant === "default"
      ? {
          ...style,
          color: "#fff",
        }
      : style;

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      style={resolvedStyle}
      {...props}
    />
  );
}

export { Button, buttonVariants };
