import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { e2eOutboxDir } from "../../playwright.config";

export type CapturedEmail = {
  subject: string;
  template: string;
  text: string;
  to: string[];
};

async function readOutbox(): Promise<CapturedEmail[]> {
  let fileNames: string[];

  try {
    fileNames = await readdir(e2eOutboxDir);
  } catch {
    return [];
  }

  const emails = await Promise.all(
    fileNames
      .filter((fileName) => fileName.endsWith(".json"))
      .sort()
      .map(async (fileName) => {
        try {
          return JSON.parse(
            await readFile(path.join(e2eOutboxDir, fileName), "utf8"),
          ) as CapturedEmail;
        } catch {
          // Unreadable right now: the next poll picks it up.
          return null;
        }
      }),
  );

  return emails.filter((email) => email !== null);
}

/** Waits for the newest captured email with this template and recipient. */
export async function waitForEmail(
  input: { template: string; to: string },
  timeoutMs = 30_000,
): Promise<CapturedEmail> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const match = (await readOutbox())
      .reverse()
      .find(
        (email) =>
          email.template === input.template && email.to.includes(input.to),
      );

    if (match) {
      return match;
    }

    if (Date.now() > deadline) {
      throw new Error(
        `No "${input.template}" email for ${input.to} within ${String(timeoutMs)} ms.`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

export function extractLinks(text: string): string[] {
  return text.match(/https?:\/\/[^\s<>"]+/g) ?? [];
}

export function extractLink(text: string, pathPrefix: string): string {
  const link = extractLinks(text).find((candidate) =>
    new URL(candidate).pathname.startsWith(pathPrefix),
  );

  if (!link) {
    throw new Error(`No link starting with ${pathPrefix} in the email.`);
  }

  return link;
}
