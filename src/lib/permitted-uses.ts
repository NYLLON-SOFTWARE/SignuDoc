// What documents this software may be used for, shown on every install at
// /electronic-signatures and confirmed by the sender before each send. The
// version is stored with each send, so the record shows which list the
// sender confirmed.

export const PERMITTED_USE_VERSION = "2026-11-13";
export const PERMITTED_USE_PATH = "/electronic-signatures";

export type UseSection = { heading: string; items: string[] };

/** Documents the US laws exclude from electronic signature (ESIGN 103, UETA 3). */
export const US_EXCLUDED_DOCUMENTS: string[] = [
  "Wills, codicils and testamentary trusts.",
  "Adoption, divorce and other family-law matters.",
  "Court orders, notices and official court documents such as briefs and pleadings.",
  "Notices of default, foreclosure, eviction or repossession under a credit agreement or lease of a primary residence.",
  "Notices that utility services (water, heat, power) will be cancelled or terminated.",
  "Notices that health or life insurance benefits will be cancelled or terminated (not including annuities).",
  "Product recall notices and notices of material failure that risk health or safety.",
  "Documents required to accompany the transport or handling of hazardous materials, pesticides or other toxic or dangerous materials.",
  "Most of the Uniform Commercial Code other than sales and leases (for example negotiable instruments such as promissory notes meant to be transferred).",
  "Anything else your state or country requires on paper, notarized or witnessed in person, such as many real property deeds.",
];

/** Documents that the EU and member states commonly keep out of simple e-signatures. */
export const EU_LIMITS: string[] = [
  "Contracts creating or transferring rights in real estate (other than rental), which most member states require in notarial form.",
  "Contracts that by law need a court, public authority or notary.",
  "Suretyship and guarantee contracts given by consumers, and family or succession law matters, in many member states.",
  "Anything your law requires to carry a qualified electronic signature (QES): Signudoc does not produce one.",
];

export const WHAT_IT_IS: UseSection = {
  heading: "What Signudoc is",
  items: [
    "A tool for ordinary business agreements: sales and service contracts, NDAs, offer letters, purchase orders, consent and approval forms, and similar documents.",
    "In the US, signatures made here are electronic signatures under ESIGN and UETA (and New York's ESRA).",
    "In the EU and UK, they are simple electronic signatures (SES) under eIDAS. A court cannot refuse them only because they are electronic, but you may need to show who signed. The audit certificate, the sealed PDF and the optional access code or email code help with that.",
  ],
};

export const WHAT_IT_IS_NOT: UseSection = {
  heading: "What Signudoc is not",
  items: [
    "Not an advanced (AdES) or qualified (QES) electronic signature under eIDAS. The seal on finished PDFs is the install's own, not a qualified seal.",
    "Not a validated FDA 21 CFR Part 11 system as it comes. An administrator can turn on Part 11 mode (signers sign with their own confirmed accounts and password, and each signature shows its meaning), but your organization still has to validate the install, write and follow its own procedures, and certify its electronic signatures to the FDA.",
    "Not a HIPAA-covered service. Do not send protected health information unless your organization has its own agreements and controls for every service the install uses.",
    "Not a consumer-disclosure system beyond the electronic-records agreement each signer gives. If a law requires you to deliver specific consumer notices electronically, check that its own rules are met.",
    "Not legal advice. Whoever runs this install decides which documents it may be used for.",
  ],
};
