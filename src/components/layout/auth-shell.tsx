"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Brand } from "@/components/layout/brand";
import { useBranding } from "@/components/layout/branding-provider";
import { PublicLegalFooter } from "@/components/layout/public-legal-links";
import { PublicSessionMenu } from "@/components/layout/public-session-menu";

type AuthShellProps = {
  children: ReactNode;
};

type AuthNavAction = {
  href: string;
  label: string;
};

function getAuthNavAction(pathname: string): AuthNavAction {
  if (pathname === "/signup") {
    return {
      href: "/login",
      label: "Log in",
    };
  }

  return {
    href: "/signup",
    label: "Sign up",
  };
}

export function AuthShell({ children }: AuthShellProps) {
  const pathname = usePathname() ?? "/login";
  const { signupAvailable } = useBranding();
  const navAction = getAuthNavAction(pathname);
  // No "Sign up" link to a page that would only say sign-up is closed.
  const showNavAction = navAction.href !== "/signup" || signupAvailable;

  return (
    <div className="flex min-h-screen flex-col bg-white">
      <header className="border-b border-(--border) bg-white">
        <div className="editorial-shell flex items-center justify-between gap-4 px-0 py-5">
          <Brand href="/" />
          <nav
            aria-label="Public navigation"
            className="flex items-center gap-3"
          >
            <PublicSessionMenu>
              {showNavAction ? (
                <Link
                  className="editorial-meta transition-colors hover:text-(--fg)"
                  href={navAction.href}
                  prefetch
                >
                  {navAction.label}
                </Link>
              ) : null}
            </PublicSessionMenu>
          </nav>
        </div>
      </header>

      <main className="editorial-shell flex flex-1 items-start justify-center px-0 py-12 sm:py-16">
        <div className="flex w-full justify-center" data-animate="enter">
          {children}
        </div>
      </main>

      <PublicLegalFooter />
    </div>
  );
}
