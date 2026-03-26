"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useState,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";

import { Brand } from "@/components/layout/brand";
import {
  primaryNavItems,
  type ShellNavItem,
} from "@/components/layout/nav-items";
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
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth/client";

type AppShellProps = {
  children: ReactNode;
  user: {
    email: string;
    name: string;
  };
};

type ShellSection = "documents" | "new-envelope" | "settings" | "workspace";

const sectionLabelMap: Record<ShellSection, string> = {
  documents: "Documents",
  "new-envelope": "New Envelope",
  settings: "Settings",
  workspace: "Workspace",
};

export function AppShell({ children, user }: AppShellProps) {
  const pathname = usePathname() ?? "/dashboard";
  const [isSigningOut, setIsSigningOut] = useState(false);
  const currentSection = resolveSection(pathname);
  const initials = getInitials(user.name);

  async function handleSignOut() {
    if (isSigningOut) {
      return;
    }

    setIsSigningOut(true);

    const result = await authClient.signOut();

    if (result.error) {
      setIsSigningOut(false);
      return;
    }

    window.location.assign("/login");
  }

  return (
    <SidebarProvider
      defaultOpen
      style={
        {
          "--sidebar-width": "15.5rem",
          "--sidebar-width-icon": "4.5rem",
          "--sidebar-width-mobile": "19rem",
        } as CSSProperties
      }
    >
      <Sidebar className="border-r-0" collapsible="icon" variant="sidebar">
        <SidebarHeader className="gap-4 border-b border-(--border) bg-white px-4 py-5 transition-all group-data-[collapsible=icon]:items-center group-data-[collapsible=icon]:px-3">
          <div className="flex items-center justify-between gap-3 group-data-[collapsible=icon]:justify-center">
            <Brand
              className="transition-all group-data-[collapsible=icon]:hidden"
              href="/"
            />
            <div className="hidden md:block">
              <SidebarTrigger className="rounded-none border border-(--border) bg-white text-muted-foreground hover:border-black hover:bg-white hover:text-(--fg)" />
            </div>
          </div>
        </SidebarHeader>

        <SidebarContent className="gap-5 bg-white px-2 py-5 group-data-[collapsible=icon]:px-3">
          <SidebarGroup className="px-2 group-data-[collapsible=icon]:px-0">
            <SidebarGroupLabel className="section-eyebrow px-2 text-(--tertiary) group-data-[collapsible=icon]:hidden">
              Workspace
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {primaryNavItems.map((item) => (
                  <AppSidebarItem
                    currentSection={currentSection}
                    item={item}
                    key={item.href}
                  />
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="border-t border-(--border) bg-white px-3 py-4 group-data-[collapsible=icon]:px-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                className="h-auto w-full justify-start gap-3 rounded-none border border-(--border) bg-white px-3 py-3 text-left text-(--fg) shadow-none hover:border-black hover:bg-white group-data-[collapsible=icon]:h-10 group-data-[collapsible=icon]:min-h-10! group-data-[collapsible=icon]:w-10 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:p-0"
                variant="outline"
              >
                <Avatar className="size-10 rounded-none bg-[#fff8f8] text-(--accent) group-data-[collapsible=icon]:size-8">
                  <AvatarFallback className="bg-[#fff8f8] text-sm font-semibold text-(--accent)">
                    {initials}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 group-data-[collapsible=icon]:hidden">
                  <p className="truncate text-sm font-semibold text-(--fg)">
                    {user.name}
                  </p>
                  <p className="truncate text-xs text-(--tertiary)">
                    {user.email}
                  </p>
                </div>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="w-64 rounded-none border border-(--border) bg-white p-2 shadow-none"
            >
              <DropdownMenuLabel className="px-3 py-2">
                <p className="text-sm font-semibold text-(--fg)">{user.name}</p>
                <p className="mt-1 text-xs font-normal text-(--tertiary)">
                  {user.email}
                </p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem asChild>
                <Link
                  className="rounded-xl px-3 py-2 text-sm font-medium text-(--fg)"
                  href="/settings"
                >
                  Settings
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="rounded-xl px-3 py-2 text-sm font-medium text-(--accent)"
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
        </SidebarFooter>

        <SidebarRail />
      </Sidebar>

      <SidebarInset className="min-h-screen bg-transparent">
        <header className="sticky top-0 z-20 border-b border-(--border) bg-white md:hidden">
          <div className="flex items-center justify-between gap-3 px-4 py-4">
            <div className="flex items-center gap-3">
              <Brand href="/" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.24em] text-(--tertiary)">
                  Sender app
                </p>
                <p className="text-sm font-semibold text-(--fg)">
                  {getSectionLabel(currentSection)}
                </p>
              </div>
            </div>
            <SidebarTrigger className="size-11 rounded-none border border-(--border) bg-white text-(--fg)" />
          </div>
        </header>

        <main className="flex-1 px-4 py-5 sm:px-6 sm:py-7 lg:px-8 xl:px-10">
          <div className="mx-auto w-full max-w-[1080px]">{children}</div>
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AppSidebarItem({
  currentSection,
  item,
}: {
  currentSection: ShellSection;
  item: ShellNavItem;
}) {
  const isActive = isItemActive(currentSection, item.href);
  const Icon = item.icon;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        className="min-h-12 rounded-none border border-transparent px-3.5 py-2 text-[0.95rem] font-medium text-muted-foreground data-[active=true]:border-(--border) data-[active=true]:bg-[#f7f7f8] data-[active=true]:text-(--fg) hover:border-(--border) hover:bg-[#f7f7f8] hover:text-(--fg) group-data-[collapsible=icon]:h-10! group-data-[collapsible=icon]:min-h-10! group-data-[collapsible=icon]:w-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:p-0!"
        isActive={isActive}
        tooltip={item.label}
      >
        <Link
          aria-current={isActive ? "page" : undefined}
          className="flex w-full items-center gap-3 group-data-[collapsible=icon]:justify-center"
          href={item.href}
        >
          <span
            className={`inline-flex size-9 shrink-0 items-center justify-center rounded-none transition group-data-[collapsible=icon]:size-4 group-data-[collapsible=icon]:rounded-none group-data-[collapsible=icon]:bg-transparent ${
              isActive
                ? "bg-[#fff8f8] text-(--accent)"
                : "bg-[#f7f7f8] text-muted-foreground"
            }`}
          >
            <Icon className="size-4" />
          </span>
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {item.label}
          </span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
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

function isItemActive(currentSection: ShellSection, href: string) {
  return currentSection === resolveSection(href);
}

function getSectionLabel(section: ShellSection) {
  return sectionLabelMap[section];
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
