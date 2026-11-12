export const MAX_SIGNERS_PER_ENVELOPE = 10;
export const MAX_UPLOAD_SIZE_BYTES = 20 * 1024 * 1024;
export const SIGNING_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const RECIPIENT_DOWNLOAD_LINK_TTL_SECONDS = 7 * 24 * 60 * 60;
export const MANUAL_NUDGE_COOLDOWN_SECONDS = 24 * 60 * 60;

export const envelopeStatuses = [
  "draft",
  "sent",
  "completed",
  "declined",
  "voided",
] as const;

export const signerStatuses = [
  "pending",
  "notified",
  "signed",
  "declined",
] as const;

export const fieldTypes = [
  "signature",
  "initials",
  "date",
  "text",
  "checkbox",
] as const;

export const fieldInputMethods = ["typed", "drawn", "auto"] as const;

export const auditEventTypes = [
  "created",
  "sent",
  "viewed",
  "consented",
  "verified",
  "verification_failed",
  "signed",
  "declined",
  "reminded_manual",
  "email_sent",
  "completed",
  "voided",
] as const;

export const auditActorTypes = ["sender", "signer", "system"] as const;

export const downloadFileTypes = ["signed", "evidence"] as const;

export const emailTemplateKinds = [
  "account_closure_request",
  "contact_form",
  "email_verification",
  "signing_invitation",
  "signing_code",
  "change_email_confirmation",
  "manual_nudge",
  "completion_notification",
  "download_links",
  "decline_notification",
  "void_notification",
  "password_reset",
  "retention_notice",
  "test_email",
] as const;

export type EnvelopeStatus = (typeof envelopeStatuses)[number];
export type SignerStatus = (typeof signerStatuses)[number];
export type FieldType = (typeof fieldTypes)[number];
export type FieldInputMethod = (typeof fieldInputMethods)[number];
export type AuditEventType = (typeof auditEventTypes)[number];
export type AuditActorType = (typeof auditActorTypes)[number];
export type DownloadFileType = (typeof downloadFileTypes)[number];
export type EmailTemplateKind = (typeof emailTemplateKinds)[number];
