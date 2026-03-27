"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import {
  CircleUserRound,
  LayoutDashboard,
  LogOut,
} from "lucide-react";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
        <Button
          aria-label="Open account menu"
          className={cn(
            "rounded-none border border-(--border) bg-white text-(--fg) shadow-none hover:border-black hover:bg-white hover:text-(--fg)",
            buttonClassName,
          )}
          size="icon-sm"
          variant="outline"
        >
          <Avatar className="size-8 rounded-none bg-[#fff8f8] text-(--accent)">
            <AvatarFallback className="bg-[#fff8f8] text-sm font-semibold text-(--accent)">
              {initials ? (
                initials
              ) : (
                <CircleUserRound className="size-4 text-(--accent)" />
              )}
            </AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        className={cn(
          "w-56 rounded-none border border-(--border) bg-white p-2 shadow-none",
          contentClassName,
        )}
      >
        <DropdownMenuLabel className="px-3 py-2">
          <p className="truncate text-sm font-semibold text-(--fg)">
            {session.user.name}
          </p>
          <p className="mt-1 truncate text-xs font-normal text-(--tertiary)">
            {session.user.email}
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            className="rounded-xl px-3 py-2 text-sm font-medium text-(--fg)"
            href="/dashboard"
            prefetch
          >
            <LayoutDashboard className="size-4" />
            Dashboard
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem
          className="rounded-xl px-3 py-2 text-sm font-medium text-(--accent)"
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
