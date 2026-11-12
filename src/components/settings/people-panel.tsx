"use client";

import { useEffect, useState } from "react";

import type { Person, PersonRole } from "@/lib/people";

// Who has an account on this install, and which of them are administrators.
// Administrators only.

const GENERIC_ERROR_MESSAGE = "Something went wrong. Please try again.";

type PeopleResponse = {
  error?: string;
  people?: Person[];
  you?: string;
} | null;

export function PeoplePanel() {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [you, setYou] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/admin/people", { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response
          .json()
          .catch(() => null)) as PeopleResponse;

        if (!response.ok || !payload?.people) {
          setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
          return;
        }

        setPeople(payload.people);
        setYou(payload.you ?? null);
      })
      .catch((loadError: unknown) => {
        // Leaving the page cancels the request; that is not a failure.
        if (!(
          loadError instanceof DOMException && loadError.name === "AbortError"
        )) {
          setError(GENERIC_ERROR_MESSAGE);
        }
      });

    return () => controller.abort();
  }, []);

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
          body: JSON.stringify({ role }),
          headers: { "content-type": "application/json" },
          method: "PATCH",
        },
      );
      const payload = (await response
        .json()
        .catch(() => null)) as PeopleResponse;

      if (!response.ok || !payload?.people) {
        setError(payload?.error ?? GENERIC_ERROR_MESSAGE);
        return;
      }

      // Having given up the role, this page is no longer theirs to see.
      if (person.id === you && role === "user") {
        window.location.reload();
        return;
      }

      setPeople(payload.people);
    } catch {
      setError(GENERIC_ERROR_MESSAGE);
    } finally {
      setPendingId(null);
    }
  }

  const needle = filter.trim().toLowerCase();
  const shown = (people ?? []).filter(
    (person) =>
      needle.length === 0 ||
      person.name.toLowerCase().includes(needle) ||
      person.email.toLowerCase().includes(needle),
  );
  const administratorCount = (people ?? []).filter(
    (person) => person.role === "admin",
  ).length;

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

      {people && people.length > 8 ? (
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
          {shown.map((person) => {
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

      {people && shown.length === 0 ? (
        <p className="text-sm text-(--secondary)">Nobody matches that.</p>
      ) : null}

      {people && people.length >= 500 ? (
        <p className="text-sm text-(--secondary)">
          Showing the first 500 accounts.
        </p>
      ) : null}
    </div>
  );
}
