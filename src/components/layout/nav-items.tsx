import type { LucideIcon } from "lucide-react";
import {
  ChevronLeft,
  ChevronRight,
  FileText,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  SquarePen,
} from "lucide-react";

export type ShellNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
};

export const primaryNavItems: ShellNavItem[] = [
  { href: "/dashboard", label: "Documents", icon: FileText },
  { href: "/envelopes/new", label: "New Envelope", icon: SquarePen },
];

export const MenuIcon = Menu;

export const CollapseIcon = PanelLeftClose;

export const ExpandIcon = PanelLeftOpen;

export const ChevronLeftIcon = ChevronLeft;

export const ChevronRightIcon = ChevronRight;
