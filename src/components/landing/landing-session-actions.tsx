"use client";

import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/cn";

type LandingSessionActionProps = {
  className?: string;
  /** "inverse" is for a button that sits on the violet closing panel. */
  tone?: "default" | "inverse";
};

export function LandingSessionPrimaryAction({
  className,
  tone = "default",
}: LandingSessionActionProps) {
  const { data: session } = authClient.useSession();
  const authenticated = !!session;

  return (
    <Link
      className={cn(
        tone === "inverse"
          ? cn(
              buttonVariants({ size: "lg", variant: "outline" }),
              "border-transparent bg-white text-(--accent-ink) hover:border-transparent hover:bg-(--accent-soft)",
            )
          : buttonVariants({ size: "lg" }),
        className,
      )}
      href={authenticated ? "/dashboard" : "/signup"}
      prefetch
    >
      {authenticated ? "Go to dashboard" : "Start free"}
    </Link>
  );
}

export function LandingSessionLoginAction({
  className,
  tone = "default",
}: LandingSessionActionProps) {
  const { data: session } = authClient.useSession();

  if (session) {
    return null;
  }

  return (
    <Link
      className={cn(
        buttonVariants({ size: "lg", variant: "outline" }),
        tone === "inverse" &&
          "border-white/45 bg-transparent text-white hover:border-white hover:bg-white/10",
        className,
      )}
      href="/login"
      prefetch
    >
      Log in
    </Link>
  );
}
