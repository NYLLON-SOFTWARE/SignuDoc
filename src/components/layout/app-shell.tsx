"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState, type ComponentProps, type ReactNode } from "react";

import { Brand } from "@/components/layout/brand";
import {
  primaryNavItems,
  type ShellNavItem,
} from "@/components/layout/nav-items";
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

type AppShellProps = {
  children: ReactNode;
  /** Shown to the administrator until email can reach signers. */
  showEmailSetupNotice?: boolean;
  user: {
    email: string;
    name: string;
  };
};

type ShellSection = "documents" | "new-envelope" | "settings" | "workspace";

export function AppShell({
  children,
  showEmailSetupNotice = false,
  user,
}: AppShellProps) {
  const pathname = usePathname() ?? "/dashboard";
  const router = useRouter();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const currentSection = resolveSection(pathname);
  const initials = getInitials(user.name);

  async function handleSignOut() {
    if (isSigningOut) {
      return;
    }

    setIsSigningOut(true);

    const result = await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          router.replace("/login");
        },
      },
    });

    if (result.error) {
      setIsSigningOut(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 bg-[rgba(243,244,248,0.86)] backdrop-blur-md">
        <div className="page-width flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3 sm:py-4">
          <div className="flex min-w-0 items-center gap-7">
            <Brand href="/" />
            <nav
              aria-label="Workspace"
              className="hidden items-center gap-1 md:flex"
            >
              {primaryNavItems.map((item) => (
                <AppNavLink
                  currentSection={currentSection}
                  item={item}
                  key={item.href}
                />
              ))}
            </nav>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                aria-label={`Account menu for ${user.name}`}
                className="inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-[#ffd9c2] text-[0.8125rem] font-bold text-[#7a3412] transition hover:ring-4 hover:ring-[rgba(28,29,43,0.06)]"
                type="button"
              >
                {initials}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="px-3 py-2">
                <p className="truncate text-sm font-bold text-(--fg)">
                  {user.name}
                </p>
                <p className="mt-0.5 truncate text-xs font-normal text-(--tertiary)">
                  {user.email}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link href="/settings">Settings</Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={isSigningOut}
                onSelect={(
                  event: ComponentProps<
                    typeof DropdownMenuItem
                  >["onSelect"] extends ((event: infer T) => void) | undefined
                    ? T
                    : never,
                ) => {
                  event.preventDefault();
                  void handleSignOut();
                }}
                variant="destructive"
              >
                {isSigningOut ? "Signing out..." : "Sign out"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <nav
            aria-label="Workspace"
            className="-mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 pb-1 md:hidden"
          >
            {primaryNavItems.map((item) => (
              <AppNavLink
                currentSection={currentSection}
                item={item}
                key={item.href}
              />
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1 pb-14 pt-2 sm:pt-4">
        <div className="page-width">
          {showEmailSetupNotice && currentSection !== "settings" ? (
            <div
              className="mb-5 flex flex-col gap-3 rounded-2xl bg-(--warning-soft) px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
              role="status"
            >
              <p className="text-sm leading-6 text-(--fg)">
                <span className="font-bold">Email is not set up yet.</span>{" "}
                Until it is, signers and new users will not receive messages
                from this site.
              </p>
              <Link
                className="shrink-0 text-sm font-bold text-(--warning) underline underline-offset-4"
                href="/settings#organization"
              >
                Finish email setup
              </Link>
            </div>
          ) : null}
          {children}
        </div>
      </main>
    </div>
  );
}

function AppNavLink({
  currentSection,
  item,
}: {
  currentSection: ShellSection;
  item: ShellNavItem;
}) {
  const isActive = currentSection === resolveSection(item.href);

  return (
    <Link
      aria-current={isActive ? "page" : undefined}
      className={cn(
        "inline-flex min-h-9 shrink-0 items-center rounded-[0.625rem] px-3.5 text-sm transition",
        isActive
          ? "bg-white font-bold text-(--fg) shadow-(--shadow-xs)"
          : "font-semibold text-(--secondary) hover:bg-[rgba(255,255,255,0.6)] hover:text-(--fg)",
      )}
      href={item.href}
    >
      {item.label}
    </Link>
  );
}

function resolveSection(pathname: string): ShellSection {
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return "settings";
  }

  if (
    pathname === "/envelopes/new" ||
    pathname.startsWith("/envelopes/new/") ||
    /^\/envelopes\/[^/]+\/(review|signers)$/.test(pathname)
  ) {
    return "new-envelope";
  }

  if (pathname === "/dashboard" || /^\/envelopes\/[^/]+$/.test(pathname)) {
    return "documents";
  }

  return "workspace";
}

function getInitials(name: string) {
  const segments = name
    .split(/\s+/)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .slice(0, 2);

  if (segments.length === 0) {
    return "SU";
  }

  return segments.map((segment) => segment[0]?.toUpperCase() ?? "").join("");
}
