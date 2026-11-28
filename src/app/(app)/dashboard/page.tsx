import { notFound } from "next/navigation";

import { DashboardShell } from "@/components/dashboard/dashboard-shell";
import { isAdminUser } from "@/lib/auth/admin";
import { getAuthSession } from "@/lib/auth/server";
import { getDb } from "@/lib/db/connection";
import {
  listAllEnvelopesForAdmin,
  listEnvelopesForUser,
  listFolderEnvelopesForUser,
  listTeamEnvelopesForUser,
  type DashboardEnvelopePage,
} from "@/lib/envelopes";
import { listFoldersForUser, listTeamsForUser } from "@/lib/teams";

const DASHBOARD_PAGE_SIZE = 48;

type DashboardPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function firstValue(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function dashboardHref(
  folderId: string,
  view: "all" | "mine" | "team",
  search = "",
  page = 1,
) {
  const params = new URLSearchParams();

  if (folderId) params.set("folder", folderId);
  else if (view !== "mine") params.set("view", view);

  if (search) params.set("q", search);
  if (page > 1) params.set("page", String(page));

  const query = params.toString();
  return query ? `/dashboard?${query}` : "/dashboard";
}

export default async function DashboardPage({
  searchParams,
}: DashboardPageProps) {
  const session = await getAuthSession();
  const database = getDb();
  const params = await searchParams;
  const folderId = firstValue(params.folder);
  const requestedView = firstValue(params.view);
  const search = firstValue(params.q).trim().slice(0, 160);
  const requestedPage = Number.parseInt(firstValue(params.page), 10);
  const page =
    Number.isSafeInteger(requestedPage) && requestedPage > 1
      ? requestedPage
      : 1;
  let result: DashboardEnvelopePage | undefined;
  let initialState: "default" | "empty" | "error" = "error";
  let folders: Awaited<ReturnType<typeof listFoldersForUser>> = [];
  let isAdmin = false;
  let hasTeam = false;

  try {
    if (session) {
      const [admin, accessibleFolders, teams] = await Promise.all([
        isAdminUser(session.user.id, database),
        listFoldersForUser(session.user.id, database),
        listTeamsForUser(session.user.id, database),
      ]);
      isAdmin = admin;
      folders = accessibleFolders;
      hasTeam = teams.length > 0;
    }
  } catch {
    return <DashboardShell initialState="error" />;
  }

  const folder = folders.find(({ id }) => id === folderId);
  if (folderId && !folder) notFound();
  const view = folder
    ? "mine"
    : isAdmin && requestedView === "all"
      ? "all"
      : hasTeam && requestedView === "team"
        ? "team"
        : "mine";
  try {
    const filters = {
      limit: DASHBOARD_PAGE_SIZE,
      page,
      ...(search ? { search } : {}),
    };
    result = !session
      ? { envelopes: [], hasMore: false }
      : folder
        ? await listFolderEnvelopesForUser(
            session.user.id,
            folder.id,
            filters,
            database,
          )
        : view === "all"
          ? await listAllEnvelopesForAdmin(session.user.id, filters, database)
          : view === "team"
            ? await listTeamEnvelopesForUser(session.user.id, filters, database)
            : await listEnvelopesForUser(session.user.id, filters, database);
    initialState =
      result.envelopes.length === 0 && !search && page === 1
        ? "empty"
        : "default";
  } catch {
    initialState = "error";
  }

  const nav = [
    { current: !folder && view === "mine", href: "/dashboard", name: "Mine" },
    ...(hasTeam
      ? [
          {
            current: view === "team",
            href: "/dashboard?view=team",
            name: "My team",
          },
        ]
      : []),
    ...(isAdmin
      ? [
          {
            current: view === "all",
            href: "/dashboard?view=all",
            name: "Everyone's",
          },
        ]
      : []),
    ...folders.map(({ id, name }) => ({
      current: folder?.id === id,
      href: dashboardHref(id, "mine"),
      name,
    })),
  ];

  return (
    <DashboardShell
      key={`${folderId}:${view}:${search}:${page}`}
      view={view}
      envelopes={result?.envelopes}
      folder={folder}
      folders={nav.length > 1 ? nav : undefined}
      initialSearch={search}
      initialState={initialState}
      pagination={{
        newerHref:
          page > 1
            ? dashboardHref(folderId, view, search, page - 1)
            : undefined,
        olderHref: result?.hasMore
          ? dashboardHref(folderId, view, search, page + 1)
          : undefined,
      }}
      resetHref={dashboardHref(folderId, view)}
    />
  );
}
