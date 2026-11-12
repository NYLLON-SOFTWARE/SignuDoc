"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { CircleUserRound, LayoutDashboard, LogOut } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { authClient } from "@/lib/auth/client";
import { cn } from "@/lib/cn";

type PublicSessionMenuProps = {
  align?: "center" | "end" | "start";
  buttonClassName?: string;
  children?: ReactNode;
  contentClassName?: string;
};

export function PublicSessionMenu({
  align = "end",
  buttonClassName,
  children = null,
  contentClassName,
}: PublicSessionMenuProps) {
  const { data: session } = authClient.useSession();
  const [isSigningOut, setIsSigningOut] = useState(false);

  if (!session) {
    return <>{children}</>;
  }

  const initials = getInitials(session.user.name);

  async function handleSignOut() {
    if (isSigningOut) {
      return;
    }

    setIsSigningOut(true);

    const result = await authClient.signOut();

    if (result.error) {
      setIsSigningOut(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Open account menu"
          className={cn(
            "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[#ffd9c2] text-[0.8125rem] font-bold text-[#7a3412] transition hover:ring-4 hover:ring-[rgba(28,29,43,0.06)]",
            buttonClassName,
          )}
          type="button"
        >
          {initials ? initials : <CircleUserRound className="size-4" />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn("w-60", contentClassName)}
      >
        <DropdownMenuLabel className="px-3 py-2">
          <p className="truncate text-sm font-bold text-(--fg)">
            {session.user.name}
          </p>
          <p className="mt-0.5 truncate text-xs font-normal text-(--tertiary)">
            {session.user.email}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link href="/dashboard" prefetch>
            <LayoutDashboard className="size-4" />
            Dashboard
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={isSigningOut}
          onSelect={(event) => {
            event.preventDefault();
            void handleSignOut();
          }}
          variant="destructive"
        >
          <LogOut className="size-4" />
          {isSigningOut ? "Signing out..." : "Log out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function getInitials(name: string) {
  const trimmedName = name.trim();

  if (!trimmedName) {
    return "";
  }

  const [first = "", second = ""] = trimmedName.split(/\s+/, 2);

  return `${first[0] ?? ""}${second[0] ?? first[1] ?? ""}`.toUpperCase();
}
