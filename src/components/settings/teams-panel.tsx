"use client";

import { useEffect, useState, type FormEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import type { Team } from "@/lib/teams";

// Teams, in Settings. Administrators only. People on a team see the
// envelopes their teammates send, and can download them once finished;
// only the sender changes an envelope. See src/lib/envelope-access.ts.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type TeamsResponse = { error?: string; teams?: Team[] } | null;

export function TeamsPanel({ kind = "team" }: { kind?: "team" | "folder" }) {
  const isFolder = kind === "folder";
  const groupName = isFolder ? "Folder" : "Team";
  const groupPlural = isFolder ? "Folders" : "Teams";
  const query = isFolder ? "?kind=folder" : "";
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [newName, setNewName] = useState("");
  const [memberEmails, setMemberEmails] = useState<Record<string, string>>({});
  // Until the first list arrives, no change is sent: its answer could land
  // before the list and then be overwritten by it, hiding the change.
  const loading = teams === null && error === null;

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/admin/teams${query}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as TeamsResponse;

        if (!response.ok || !payload?.teams) {
          setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setTeams(payload.teams);
      })
      .catch((loadError: unknown) => {
        if (!(
          loadError instanceof DOMException && loadError.name === "AbortError"
        )) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, [query]);

  /** Sends one change, and shows the list as it stands after it. */
  async function change(
    path: string,
    method: "DELETE" | "PATCH" | "POST",
    body?: unknown,
  ): Promise<boolean> {
    if (pending || loading) {
      return false;
    }

    setPending(true);
    setError(null);

    try {
      const response = await fetch(`${path}${query}`, {
        ...(body === undefined
          ? {}
          : {
              body: JSON.stringify(body),
              headers: { "content-type": "application/json" },
            }),
        method,
      });
      const payload = (await response
        .json()
        .catch(() => null)) as TeamsResponse;

      if (!response.ok || !payload?.teams) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return false;
      }

      setTeams(payload.teams);
      return true;
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
      return false;
    } finally {
      setPending(false);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      await change("/api/admin/teams", "POST", {
        name: newName,
      })
    ) {
      setNewName("");
    }
  }

  async function handleAddMember(
    event: FormEvent<HTMLFormElement>,
    team: Team,
  ) {
    event.preventDefault();

    if (
      await change(
        `/api/admin/teams/${encodeURIComponent(team.id)}/members`,
        "POST",
        { email: memberEmails[team.id] ?? "" },
      )
    ) {
      setMemberEmails((current) => ({ ...current, [team.id]: "" }));
    }
  }

  async function handleRename(team: Team) {
    const name = window.prompt(`New name for the ${kind}`, team.name);

    if (name === null || name.trim() === team.name) {
      return;
    }

    await change(`/api/admin/teams/${encodeURIComponent(team.id)}`, "PATCH", {
      name,
    });
  }

  async function handleDelete(team: Team) {
    if (
      !window.confirm(
        isFolder
          ? `Delete the folder "${team.name}"? Only empty folders can be deleted.`
          : `Delete the team "${team.name}"? Its members keep their envelopes, but stop seeing each other's.`,
      )
    ) {
      return;
    }

    await change(`/api/admin/teams/${encodeURIComponent(team.id)}`, "DELETE");
  }

  return (
    <div className="space-y-5 border-t border-(--border) pt-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          {groupPlural}
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          {isFolder
            ? "People with access to a folder can see its sent envelopes. Drafts stay private to their sender. Administrators can see every sent envelope."
            : "People on a team can see the unfiled envelopes their teammates send. Only the sender can change, remind or void an envelope, and drafts stay private."}
        </p>
      </div>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}

      <form
        className="well grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-end"
        onSubmit={handleCreate}
      >
        <label className="grid gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            {groupName} name
          </span>
          <input
            className="field-input"
            disabled={pending || loading}
            maxLength={80}
            onChange={(event) => setNewName(event.target.value)}
            placeholder={isFolder ? "Vendor agreements" : "Sales"}
            type="text"
            value={newName}
          />
        </label>
        <ShellButton
          disabled={pending || loading || newName.trim().length === 0}
          type="submit"
        >
          Add {kind}
        </ShellButton>
      </form>

      {teams === null && !error ? (
        <p className="text-sm text-(--secondary)">
          Loading {groupPlural.toLowerCase()}...
        </p>
      ) : null}

      {teams && teams.length === 0 ? (
        <p className="text-sm text-(--secondary)">
          No {groupPlural.toLowerCase()} yet.
        </p>
      ) : null}

      {teams && teams.length > 0 ? (
        <ul aria-label={groupPlural} className="space-y-3">
          {teams.map((team) => (
            <li className="well space-y-3 p-4" key={team.id}>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="truncate text-[0.9375rem] font-bold text-(--fg)">
                    {team.name}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn-quiet"
                    disabled={pending}
                    onClick={() => void handleRename(team)}
                    type="button"
                  >
                    Rename
                  </button>
                  <button
                    className="btn-quiet btn-quiet-danger"
                    disabled={pending}
                    onClick={() => void handleDelete(team)}
                    type="button"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {team.members.length > 0 ? (
                <ul
                  aria-label={`Members of ${team.name}`}
                  className="space-y-2"
                >
                  {team.members.map((member) => (
                    <li
                      className="flex items-center justify-between gap-3 rounded-xl bg-white px-3 py-2"
                      key={member.id}
                    >
                      <span className="min-w-0 truncate text-sm text-(--fg)">
                        {member.name}{" "}
                        <span className="text-(--secondary)">
                          {member.email}
                        </span>
                      </span>
                      <button
                        aria-label={`Remove ${member.email} from ${team.name}`}
                        className="btn-quiet btn-quiet-danger shrink-0"
                        disabled={pending}
                        onClick={() =>
                          void change(
                            `/api/admin/teams/${encodeURIComponent(team.id)}/members/${encodeURIComponent(member.id)}`,
                            "DELETE",
                          )
                        }
                        type="button"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-(--secondary)">No members yet.</p>
              )}

              <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(event) => void handleAddMember(event, team)}
              >
                <input
                  aria-label={`Email of someone to add to ${team.name}`}
                  className="field-input sm:max-w-xs"
                  disabled={pending}
                  onChange={(event) =>
                    setMemberEmails((current) => ({
                      ...current,
                      [team.id]: event.target.value,
                    }))
                  }
                  placeholder="name@example.com"
                  type="email"
                  value={memberEmails[team.id] ?? ""}
                />
                <button
                  className="btn-quiet"
                  disabled={
                    pending || (memberEmails[team.id] ?? "").trim() === ""
                  }
                  type="submit"
                >
                  Add member
                </button>
              </form>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
