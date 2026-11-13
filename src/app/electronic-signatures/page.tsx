import type { Metadata } from "next";
import { connection } from "next/server";

import { PublicDocumentShell } from "@/components/layout/public-document-shell";
import {
  EU_LIMITS,
  PERMITTED_USE_VERSION,
  US_EXCLUDED_DOCUMENTS,
  WHAT_IT_IS,
  WHAT_IT_IS_NOT,
} from "@/lib/permitted-uses";
import { getBranding } from "@/lib/settings";

export const metadata: Metadata = {
  description:
    "Which documents can be signed here, and what kind of electronic signature this is.",
  title: "Electronic signatures: what this is for",
};

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-2 pl-6">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}

// On every install, hosted or not: senders confirm this list before each
// send, and signers can read it.
export default async function ElectronicSignaturesPage() {
  await connection();

  const { productName } = await getBranding();

  return (
    <PublicDocumentShell
      description={`${productName} uses Signudoc to collect electronic signatures. This page says which documents that is meant for, and which it is not.`}
      lastUpdated={PERMITTED_USE_VERSION}
      title="What this is for"
    >
      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          {WHAT_IT_IS.heading}
        </h2>
        <List items={WHAT_IT_IS.items} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          {WHAT_IT_IS_NOT.heading}
        </h2>
        <List items={WHAT_IT_IS_NOT.items} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Do not send these documents (United States)
        </h2>
        <p>
          The federal ESIGN Act (15 U.S.C. 7003) and the Uniform Electronic
          Transactions Act adopted by the states leave these out, so an
          electronic signature may not make them valid:
        </p>
        <List items={US_EXCLUDED_DOCUMENTS} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Take care with these (European Union)
        </h2>
        <p>
          eIDAS lets member states decide which documents need a stronger form.
          Commonly these do:
        </p>
        <List items={EU_LIMITS} />
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-extrabold tracking-[-0.02em] text-(--fg)">
          Who decides
        </h2>
        <p>
          {productName} runs this site and decides what it may be used for.
          Before each send, the sender confirms the document is not one of the
          kinds listed here. This page is general information, not legal advice.
        </p>
      </section>
    </PublicDocumentShell>
  );
}
