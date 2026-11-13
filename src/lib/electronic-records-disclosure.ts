// What a signer is told, and agrees to, before signing: the disclosure the
// US laws on electronic signatures expect (ESIGN 101(c), UETA 5) and that
// works as a plain statement of terms elsewhere. Its version is stored with
// each signer's agreement, so the record shows which words they saw. Change
// the version whenever the words change.

export const ELECTRONIC_RECORDS_DISCLOSURE_VERSION = "2026-11-13";

export type DisclosureParty = {
  /** Who to ask for a paper copy or to withdraw: the organization or sender. */
  contactAddress: string | null;
  senderName: string;
};

export type DisclosureSection = { heading: string; text: string };

export function buildElectronicRecordsDisclosure(
  party: DisclosureParty,
): DisclosureSection[] {
  const contact = party.contactAddress
    ? `${party.senderName} at ${party.contactAddress}`
    : party.senderName;

  return [
    {
      heading: "Using electronic records and signatures",
      text: `${party.senderName} asks you to receive this document and sign it electronically instead of on paper. If you agree, your electronic signature has the same effect as a handwritten one, and the documents you receive this way count as delivered to you in writing.`,
    },
    {
      heading: "You can choose paper instead",
      text: `You do not have to agree. To sign on paper instead, or to ask for a paper copy of any document after signing, contact ${contact}. A paper copy is free unless ${party.senderName} tells you otherwise before you ask.`,
    },
    {
      heading: "Withdrawing your agreement",
      text: `You can withdraw this agreement at any time before you sign by declining or by telling ${contact}. Withdrawing does not undo a signature you already gave.`,
    },
    {
      heading: "What you need",
      text: "A current web browser and a device that can open and save PDF files. You will receive the signed document by email, so keep your email address up to date with the sender. Download and keep the signed copy: it is your record.",
    },
    {
      heading: "This agreement covers",
      text: "This document and the notices about it that are sent to you through this site.",
    },
  ];
}

export const CONSENT_STATEMENT =
  "I have read the disclosure above, I can open and save PDF files on this device, and I agree to use electronic records and signatures for this document.";
