import { ChevronLeft, ChevronRight } from "lucide-react";

export type ShellNavItem = {
  href: string;
  label: string;
};

export const primaryNavItems: ShellNavItem[] = [
  { href: "/dashboard", label: "Documents" },
  { href: "/envelopes/new", label: "New envelope" },
  { href: "/settings", label: "Settings" },
];

export const ChevronLeftIcon = ChevronLeft;

export const ChevronRightIcon = ChevronRight;
