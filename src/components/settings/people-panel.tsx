"use client";

import { useEffect, useState } from "react";

import type { PeopleList, Person, PersonRole } from "@/lib/people";

// Who has an account on this install, and which of them are administrators.
// Administrators only.
//
// The list that arrives stops at five hundred accounts, so finding a person
// is the server's job: what is typed is sent along, and the list on screen
// is the answer to it.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";
/** How long typing has to pause before the list is asked for again. */
const SEARCH_DELAY_MS = 250;
/** With fewer accounts than this, nobody needs to search. */
const SEARCH_FROM_TOTAL = 9;

type PeopleResponse =
  (Partial<PeopleList> & { error?: string; you?: string }) | null;

function readPeopleList(payload: PeopleResponse): PeopleList | null {
  if (!payload || !Array.isArray(payload.people)) {
    return null;
  }

  return {
    administratorCount:
      payload.administratorCount ??
      payload.people.filter((person) => person.role === "admin").length,
    people: payload.people,
    total: payload.total ?? payload.people.length,
  };
}

export function PeoplePanel() {
  const [list, setList] = useState<PeopleList | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // What the list on screen was asked for: `filter`, once typing has paused.
  const [search, setSearch] = useState("");

  useEffect(() => {
    const timer = window.setTimeout(
      () => setSearch(filter.trim()),
      SEARCH_DELAY_MS,
    );

    return () => window.clearTimeout(timer);
  }, [filter]);

  useEffect(() => {
    const controller = new AbortController();

    fetch(`/api/admin/people?search=${encodeURIComponent(search)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as PeopleResponse;
        const loaded = readPeopleList(payload);

        if (!response.ok || !loaded) {
          setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setList(loaded);
        setYou(payload?.you ?? null);
        setError(null);
      })
      .catch((loadError: unknown) => {
        // Leaving the page, or typing on, cancels the request; that is not
        // a failure.
        if (!(
          loadError instanceof DOMException && loadError.name === "AbortError"
        )) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, [search]);

  async function changeRole(person: Person, role: PersonRole) {
    if (pendingId) {
      return;
    }

    setPendingId(person.id);
    setError(null);

    try {
      const response = await fetch(
        `/api/admin/people/${encodeURIComponent(person.id)}`,
        {
          body: JSON.stringify({ role, search }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
      const payload = (await response
        .json()
        .catch(() => null)) as PeopleResponse;
      const changed = readPeopleList(payload);

      if (!response.ok || !changed) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      // Having given up the role, this page is no longer theirs to see.
      if (person.id === you && role === "user") {
        window.location.reload();
        return;
      }

      setList(changed);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingId(null);
    }
  }

  const people = list?.people ?? null;
  const administratorCount = list?.administratorCount ?? 0;
  const searching = filter.trim().length > 0 || search.length > 0;
  const canSearch =
    list !== null && (searching || list.total >= SEARCH_FROM_TOTAL);

  return (
    <div className="space-y-5 border-t border-(--border) pt-8">
      <div className="space-y-2">
        <h3 className="text-lg font-extrabold tracking-[-0.02em] text-(--fg)">
          People
        </h3>
        <p className="max-w-2xl text-sm leading-6 text-(--secondary)">
          Everyone with an account here. Administrators can change these
          settings, answer signer data requests and receive the finished
          documents of accounts that are closed. Keep at least two, so that one
          person leaving does not lock everyone out.
        </p>
      </div>

      {error ? (
        <div className="notice notice-danger" role="alert">
          {error}
        </div>
      ) : null}

      {people === null && !error ? (
        <p className="text-sm text-(--secondary)">Loading people...</p>
      ) : null}

      {canSearch ? (
        <label className="grid max-w-sm gap-1.5">
          <span className="text-[0.8125rem] font-semibold text-(--secondary)">
            Find a person
          </span>
          <input
            className="field-input"
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Name or email"
            type="search"
            value={filter}
          />
        </label>
      ) : null}

      {people ? (
        <ul aria-label="People" className="space-y-3">
          {people.map((person) => {
            const isAdmin = person.role === "admin";
            const isYou = person.id === you;
            const isLastAdmin = isAdmin && administratorCount === 1;

            return (
              <li
                className="well flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
                key={person.id}
              >
                <div className="min-w-0 space-y-1.5">
                  <p className="truncate text-[0.9375rem] font-bold text-(--fg)">
                    {person.name}
                  </p>
                  <p className="truncate text-sm text-(--secondary)">
                    {person.email}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <span
                      className={`pill ${isAdmin ? "pill-accent" : "pill-neutral"}`}
                    >
                      {isAdmin ? "Administrator" : "Member"}
                    </span>
                    {isYou ? (
                      <span className="pill pill-neutral">You</span>
                    ) : null}
                    {!person.emailVerified ? (
                      <span className="pill pill-warning">
                        Email not confirmed
                      </span>
                    ) : null}
                    {person.closing ? (
                      <span className="pill pill-warning">Closing</span>
                    ) : null}
                  </div>
                </div>

                {isAdmin ? (
                  <button
                    aria-label={`Remove ${person.name} as administrator`}
                    className="btn-quiet btn-quiet-danger shrink-0"
                    disabled={pendingId !== null || isLastAdmin}
                    onClick={() => void changeRole(person, "user")}
                    title={
                      isLastAdmin
                        ? "There has to be at least one administrator."
                        : undefined
                    }
                    type="button"
                  >
                    {pendingId === person.id
                      ? "Saving..."
                      : "Remove as administrator"}
                  </button>
                ) : (
                  <button
                    aria-label={`Make ${person.name} an administrator`}
                    className="btn-quiet shrink-0"
                    disabled={
                      pendingId !== null ||
                      !person.emailVerified ||
                      person.closing
                    }
                    onClick={() => void changeRole(person, "admin")}
                    type="button"
                  >
                    {pendingId === person.id
                      ? "Saving..."
                      : "Make administrator"}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      {people && people.length === 0 ? (
        <p className="text-sm text-(--secondary)">Nobody matches that.</p>
      ) : null}

      {list && list.total > list.people.length ? (
        <p className="text-sm text-(--secondary)">
          Showing the first {list.people.length} of {list.total}. Type part of a
          name or an email address above to find the others.
        </p>
      ) : null}
    </div>
  );
}
