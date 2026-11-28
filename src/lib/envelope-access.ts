import { type DbExecutor, getDb, queryOne } from "./db/connection.ts";

export type EnvelopeViewerAccess = {
  folderId: string | null;
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  /** Whether the viewer is an administrator of the install. */
  viewerIsAdmin: boolean;
  /**
   * False when an administrator or folder member views someone else's envelope.
   */
  viewerIsOwner: boolean;
};

type AccessRow = {
  canAccessFolder: boolean;
  folderId: string | null;
  ownerEmail: string;
  ownerName: string | null;
  ownerUserId: string;
  sharesTeam: boolean;
  status: string;
  viewerRole: string | null;
};

/**
 * SQL for the folder boundary. Callers also enforce envelope ownership,
 * status, and action-specific permissions.
 */
export function canAccessEnvelopeFolderCondition(
  viewer: string,
  alias = "envelopes",
): string {
  return `(
    ${alias}.folder_id IS NULL
    OR EXISTS (
      SELECT 1 FROM public."user"
      WHERE id = ${viewer} AND role = 'admin'
    )
    OR EXISTS (
      SELECT 1
      FROM team_members membership
      JOIN teams folder ON folder.id = membership.team_id AND folder.is_folder
      WHERE membership.user_id = ${viewer}
        AND membership.team_id = ${alias}.folder_id
    )
  )`;
}

export function sharesTeamCondition(
  viewer: string,
  alias = "envelopes",
): string {
  return `EXISTS (
    SELECT 1
    FROM team_members viewer_membership
    JOIN team_members owner_membership ON owner_membership.team_id = viewer_membership.team_id
    JOIN teams team ON team.id = viewer_membership.team_id AND NOT team.is_folder
    WHERE viewer_membership.user_id = ${viewer}
      AND owner_membership.user_id = ${alias}.user_id
  )`;
}

/** The sender and access level for a visible envelope. */
export async function resolveEnvelopeViewerAccess(
  viewerUserId: string,
  envelopeId: string,
  database: DbExecutor = getDb(),
): Promise<EnvelopeViewerAccess | null> {
  const row = await queryOne<AccessRow>(
    database,
    `
      SELECT
        e.user_id AS "ownerUserId",
        e.folder_id AS "folderId",
        owner.email AS "ownerEmail",
        owner.name AS "ownerName",
        e.status,
        (SELECT role FROM public."user" WHERE id = $2) AS "viewerRole",
        ${canAccessEnvelopeFolderCondition("$2", "e")} AS "canAccessFolder",
        (e.folder_id IS NULL AND ${sharesTeamCondition("$2", "e")}) AS "sharesTeam"
      FROM envelopes e
      JOIN public."user" owner ON owner.id = e.user_id
      WHERE e.id = $1
    `,
    [envelopeId, viewerUserId],
  );

  if (!row) {
    return null;
  }

  const viewerIsOwner = row.ownerUserId === viewerUserId;

  if (
    !row.canAccessFolder ||
    (!viewerIsOwner &&
      (row.status === "draft" ||
        (row.folderId === null &&
          row.viewerRole !== "admin" &&
          !row.sharesTeam)))
  ) {
    return null;
  }

  return {
    folderId: row.folderId,
    ownerEmail: row.ownerEmail,
    ownerName: row.ownerName,
    ownerUserId: row.ownerUserId,
    viewerIsAdmin: row.viewerRole === "admin",
    viewerIsOwner,
  };
}

/** How someone other than the sender sees who sent an envelope. */
export function formatEnvelopeOwner(
  access: Pick<EnvelopeViewerAccess, "ownerEmail" | "ownerName">,
): string {
  const name = access.ownerName?.trim();

  return name ? `${name} (${access.ownerEmail})` : access.ownerEmail;
}
