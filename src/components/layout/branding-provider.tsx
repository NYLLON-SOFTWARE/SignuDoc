"use client";

import { createContext, useContext, type ReactNode } from "react";

import { HOSTED_BRANDING, type Branding } from "@/lib/branding";

// What this install calls itself, handed down from the server layouts that
// looked it up, and from PublicDocumentShell for the pages outside them. The
// one page with neither (the landing page) only exists in hosted mode, which
// is also the default here.
const BrandingContext = createContext<Branding>(HOSTED_BRANDING);

type BrandingProviderProps = {
  branding: Branding;
  children: ReactNode;
};

export function BrandingProvider({
  branding,
  children,
}: BrandingProviderProps) {
  return (
    <BrandingContext.Provider value={branding}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding(): Branding {
  return useContext(BrandingContext);
}
