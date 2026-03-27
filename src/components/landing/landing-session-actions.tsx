"use client";

import Link from "next/link";

import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/cn";

type LandingSessionActionProps = {
  className?: string;
  monoClassName: string;
};

export function LandingSessionPrimaryAction({
  className,
  monoClassName,
}: LandingSessionActionProps) {
  const { data: session } = authClient.useSession();
  const authenticated = !!session;

  return (
    <Link
      className={landingActionLinkClassName({
        className,
        monoClassName,
        variant: "primary",
      })}
      href={authenticated ? "/dashboard" : "/signup"}
      prefetch
      style={{ color: "#fff" }}
    >
      {authenticated ? "Go to dashboard" : "Start free"}
    </Link>
  );
}

export function LandingSessionLoginAction({
  className,
  monoClassName,
}: LandingSessionActionProps) {
  const { data: session } = authClient.useSession();

  if (session) {
    return null;
  }

  return (
    <Link
      className={landingActionLinkClassName({
        className,
        monoClassName,
        variant: "secondary",
      })}
      href="/login"
      prefetch
    >
      Log in
    </Link>
  );
}

function landingActionLinkClassName({
  className,
  monoClassName,
  variant,
}: {
  className?: string;
  monoClassName: string;
  variant: "primary" | "secondary";
}) {
  return cn(
    `${monoClassName} inline-flex items-center justify-center border-2 px-5 py-3 text-sm font-bold uppercase tracking-[0.16em] transition-colors`,
    variant === "primary"
      ? "border-[#e50000] bg-[#e50000] text-white hover:border-[#c00000] hover:bg-[#c00000]"
      : "border-[#d4d4d4] bg-transparent text-black hover:border-black",
    className,
  );
}
