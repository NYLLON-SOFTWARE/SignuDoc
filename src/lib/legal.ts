export const PUBLIC_COPYRIGHT_YEAR = 2026;

export const publicLegalLinks = [
  {
    href: "/terms",
    longLabel: "Terms of Service",
    shortLabel: "Terms",
  },
  {
    href: "/privacy",
    longLabel: "Privacy Policy",
    shortLabel: "Privacy",
  },
  {
    href: "/contact",
    longLabel: "Contact",
    shortLabel: "Contact",
  },
] as const;

export const publicFooterLinks = [
  publicLegalLinks[0],
  publicLegalLinks[1],
  {
    href: "/accessibility",
    longLabel: "Accessibility Statement",
    shortLabel: "Accessibility",
  },
  publicLegalLinks[2],
] as const;
