// The OpenAPI 3.1 description of /api/v1, served at /api/v1/openapi.json.
// openapi.test.ts checks that every route file has a path here and every
// path here has a route file, so the two cannot drift apart. Lists of
// allowed values come from the app's own, so they cannot drift either.

import { getMaxSignersPerEnvelope } from "../signer-limit.ts";
import {
  fieldTypes,
  MAX_SIGNERS_CEILING,
  signatureMeanings,
} from "../types/domain.ts";

import { webhookEventTypes } from "../webhooks/events.ts";

const errorResponse = {
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Error" } },
  },
  description: "An error. See the code.",
};

const errors = {
  "400": errorResponse,
  "401": errorResponse,
  "403": errorResponse,
  "404": errorResponse,
  "409": errorResponse,
  "429": errorResponse,
  "500": errorResponse,
};

// For the calls that email signers: 503 when the install has no email yet.
const emailErrors = {
  ...errors,
  "503": {
    ...errorResponse,
    description: "Email is not set up on the install yet, so nothing was sent.",
  },
};

const envelopeResponse = (description: string) => ({
  content: {
    "application/json": { schema: { $ref: "#/components/schemas/Envelope" } },
  },
  description,
});

const idParameter = {
  in: "path",
  name: "id",
  required: true,
  schema: { type: "string" },
};

const idempotencyKey = {
  description:
    "Any unique string of 1 to 255 characters, not only spaces (spaces at either end are ignored). A retry with the same key and body within 24 hours gets the first response again. While the first request is still running, a retry gets 409 with Retry-After. If the first request made its envelope but failed before answering, a retry gets that envelope as it is now.",
  in: "header",
  name: "Idempotency-Key",
  required: false,
  schema: { maxLength: 255, minLength: 1, pattern: "\\S", type: "string" },
};

/** A person's name: not blank, and spaces at either end are dropped. */
const personNameSchema = {
  maxLength: 120,
  minLength: 1,
  pattern: "\\S",
  type: "string",
};

/** Titles: not blank, and spaces at either end are dropped. */
const titleSchema = {
  maxLength: 160,
  minLength: 1,
  pattern: "\\S",
  type: "string",
};

const isoTime = { format: "date-time", type: ["string", "null"] };

/** A {"object": "list", "data": [...]} answer of `item`s. */
const listOf = (item: Record<string, unknown>) => ({
  properties: {
    data: { items: item, type: "array" },
    object: { const: "list", type: "string" },
  },
  required: ["object", "data"],
  type: "object",
});

/**
 * maxSigners is this install's limit, MAX_SIGNERS_PER_ENVELOPE, so the
 * description says what this install accepts.
 */
export function buildOpenApiDocument(
  serverUrl: string,
  maxSigners: number = getMaxSignersPerEnvelope(),
) {
  return {
    components: {
      schemas: {
        CreateEnvelope: {
          properties: {
            copyRecipients: {
              items: {
                properties: {
                  email: { format: "email", type: "string" },
                  name: personNameSchema,
                },
                required: ["name", "email"],
                type: "object",
              },
              maxItems: 10,
              type: "array",
            },
            fields: {
              items: { $ref: "#/components/schemas/Field" },
              maxItems: 500,
              minItems: 1,
              type: "array",
            },
            filename: {
              description: "With uploadId: the file name to keep.",
              type: "string",
            },
            metadata: {
              description:
                "Up to 2048 bytes of JSON, returned with the envelope.",
              type: "object",
            },
            send: { $ref: "#/components/schemas/SendOptions" },
            signers: {
              items: {
                properties: {
                  accessCode: { maxLength: 64, minLength: 4, type: "string" },
                  email: { format: "email", type: "string" },
                  name: personNameSchema,
                  ref: {
                    description: "Your name for this signer, used by fields.",
                    pattern: "^[A-Za-z0-9._:-]{1,64}$",
                    type: "string",
                  },
                  requireEmailCode: { type: "boolean" },
                  signatureMeaning: {
                    description: "Part 11 installs only.",
                    enum: [...signatureMeanings],
                    type: "string",
                  },
                  step: {
                    description:
                      "The step of the signing order. Signers who share a step sign at the same time, and the next step starts once they all have. Give it for every signer or for none; left out, they sign one after the other.",
                    maximum: MAX_SIGNERS_CEILING,
                    minimum: 1,
                    type: "integer",
                  },
                },
                required: ["ref", "name", "email"],
                type: "object",
              },
              maxItems: maxSigners,
              minItems: 1,
              type: "array",
            },
            title: titleSchema,
            uploadId: {
              description: "With JSON: the id from POST /uploads.",
              type: "string",
            },
          },
          required: ["title", "signers", "fields"],
          type: "object",
        },
        Envelope: {
          properties: {
            completedAt: isoTime,
            copyRecipients: {
              items: {
                properties: {
                  email: { type: "string" },
                  id: { type: "string" },
                  name: { type: "string" },
                },
                type: "object",
              },
              type: "array",
            },
            createdAt: { format: "date-time", type: "string" },
            declinedAt: isoTime,
            delivery: { enum: ["email", "embedded"], type: "string" },
            expired: { type: "boolean" },
            expiresAt: isoTime,
            files: {
              properties: {
                certificate: { type: ["string", "null"] },
                signed: { type: ["string", "null"] },
              },
              type: "object",
            },
            id: { type: "string" },
            metadata: { type: ["object", "null"] },
            object: { const: "envelope" },
            pageCount: { type: "integer" },
            sentAt: isoTime,
            signatureLevel: {
              enum: ["simple", "advanced", "qualified"],
              type: "string",
            },
            signers: {
              items: { $ref: "#/components/schemas/Signer" },
              type: "array",
            },
            status: {
              enum: ["draft", "sent", "completed", "declined", "voided"],
              type: "string",
            },
            title: { type: "string" },
            voidedAt: isoTime,
          },
          type: "object",
        },
        Error: {
          properties: {
            error: {
              properties: {
                code: {
                  enum: [
                    "invalid_request",
                    "unauthorized",
                    "forbidden",
                    "not_found",
                    "wrong_state",
                    "payload_too_large",
                    "idempotency_key_reused",
                    "rate_limited",
                    "internal_error",
                  ],
                  type: "string",
                },
                message: { type: "string" },
              },
              required: ["code", "message"],
              type: "object",
            },
          },
          required: ["error"],
          type: "object",
        },
        Field: {
          description:
            "Position and size are fractions of the page (0 to 1), measured from its top left corner.",
          properties: {
            groupId: {
              description: "Radio buttons in one group.",
              maxLength: 64,
              minLength: 1,
              pattern: "\\S",
              type: "string",
            },
            height: { exclusiveMinimum: 0, maximum: 1, type: "number" },
            label: { maxLength: 120, type: "string" },
            options: {
              description: "Dropdowns only.",
              items: { type: "string" },
              type: "array",
            },
            page: { minimum: 1, type: "integer" },
            required: { default: true, type: "boolean" },
            signer: { description: "The signer's ref.", type: "string" },
            type: { enum: [...fieldTypes], type: "string" },
            width: { exclusiveMinimum: 0, maximum: 1, type: "number" },
            x: { maximum: 1, minimum: 0, type: "number" },
            y: { maximum: 1, minimum: 0, type: "number" },
          },
          required: ["signer", "type", "page", "x", "y", "width", "height"],
          type: "object",
        },
        SendOptions: {
          properties: {
            delivery: {
              default: "email",
              description:
                "embedded: signers sign inside your app (see POST /envelopes/{id}/signers/{signerId}/embed-link), and no invitations or reminders are emailed. It needs a site on the install's list of allowed sites, simple signatures (signatureLevel simple), no signer accessCode or requireEmailCode, and an install that is not in Part 11 mode; otherwise the send is refused with 400.",
              enum: ["email", "embedded"],
              type: "string",
            },
            expiresInDays: { maximum: 365, minimum: 1, type: "integer" },
            permittedUseConfirmed: {
              const: true,
              description:
                "Confirms the envelope is an ordinary business agreement, as the web app's send button does.",
            },
            reminderIntervalDays: {
              description: "Days between reminders, or null for none.",
              maximum: 30,
              minimum: 1,
              type: ["integer", "null"],
            },
            reminderSchedule: {
              description:
                "When set, reminds each waiting signer on days 3 and 7 of their turn and overrides reminderIntervalDays.",
              enum: ["days_3_and_7", null],
              type: ["string", "null"],
            },
            signatureLevel: {
              description:
                "advanced and qualified are sent by email only, not with delivery embedded.",
              enum: ["simple", "advanced", "qualified"],
              type: "string",
            },
          },
          required: ["permittedUseConfirmed"],
          type: "object",
        },
        Signer: {
          properties: {
            declineReason: { type: ["string", "null"] },
            declinedAt: isoTime,
            email: { type: "string" },
            id: { type: "string" },
            name: { type: "string" },
            order: { type: "integer" },
            ref: { type: ["string", "null"] },
            role: {
              description:
                "approver: reviews the document and approves or rejects it instead of signing. An approval is signed, a rejection declined.",
              enum: ["signer", "approver"],
              type: "string",
            },
            signedAt: isoTime,
            status: {
              description:
                "pending: not their turn yet. notified: their turn, invited. signed. declined.",
              enum: ["pending", "notified", "signed", "declined"],
              type: "string",
            },
            step: {
              description:
                "Their step of the signing order. Signers who share a step sign at the same time.",
              type: "integer",
            },
            viewedAt: isoTime,
          },
          type: "object",
        },
        Template: {
          properties: {
            id: { type: "string" },
            name: { type: "string" },
            object: { const: "template", type: "string" },
            roles: {
              description: "Its roles, in signing order.",
              items: { type: "string" },
              type: "array",
            },
          },
          required: ["object", "id", "name", "roles"],
          type: "object",
        },
        Upload: {
          properties: {
            expiresAt: { format: "date-time", type: "string" },
            headers: {
              additionalProperties: { type: "string" },
              description: "Send these headers with the PUT.",
              type: "object",
            },
            maxBytes: { type: "integer" },
            method: { const: "PUT", type: "string" },
            uploadId: {
              description: "Pass it to POST /envelopes once the PUT is done.",
              type: "string",
            },
            url: { format: "uri", type: "string" },
          },
          required: ["uploadId", "url", "method", "headers", "expiresAt"],
          type: "object",
        },
        WebhookDelivery: {
          properties: {
            attempts: { type: "integer" },
            createdAt: { format: "date-time", type: "string" },
            deliveredAt: isoTime,
            endpointId: { type: "string" },
            envelopeId: { type: ["string", "null"] },
            id: {
              description: "The webhook-id header it was sent with.",
              type: "string",
            },
            lastStatusCode: { type: ["integer", "null"] },
            object: { const: "webhook_delivery", type: "string" },
            payload: {
              description:
                "The JSON body it carries: made at its first try and sent unchanged on every later one. Null before its first try. A delivery that failed because its signing secret could not be read has one but was never sent.",
              type: ["object", "null"],
            },
            status: {
              enum: ["delivered", "failed", "pending"],
              type: "string",
            },
            type: { enum: [...webhookEventTypes], type: "string" },
          },
          required: [
            "object",
            "id",
            "type",
            "status",
            "attempts",
            "endpointId",
            "envelopeId",
            "lastStatusCode",
            "payload",
            "createdAt",
            "deliveredAt",
          ],
          type: "object",
        },
      },
      securitySchemes: {
        apiKey: {
          description: "An API key from Settings, Organization, API keys.",
          scheme: "bearer",
          type: "http",
        },
      },
    },
    info: {
      description:
        "Create, send and track envelopes on a SignuDoc install. See docs/api.md in the SignuDoc repository.",
      title: "SignuDoc API",
      version: "1",
    },
    openapi: "3.1.0",
    paths: {
      "/envelopes": {
        get: {
          parameters: [
            {
              in: "query",
              name: "status",
              schema: {
                enum: ["draft", "sent", "completed", "declined", "voided"],
                type: "string",
              },
            },
            {
              in: "query",
              name: "limit",
              schema: {
                default: 25,
                maximum: 100,
                minimum: 1,
                type: "integer",
              },
            },
            {
              in: "query",
              name: "cursor",
              schema: { maxLength: 200, type: "string" },
            },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      data: {
                        items: { $ref: "#/components/schemas/Envelope" },
                        type: "array",
                      },
                      nextCursor: { type: ["string", "null"] },
                      object: { const: "list", type: "string" },
                    },
                    required: ["object", "data", "nextCursor"],
                    type: "object",
                  },
                },
              },
              description: "A page of envelopes, newest first.",
            },
            ...errors,
          },
          summary: "List envelopes",
        },
        post: {
          parameters: [idempotencyKey],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  allOf: [
                    { $ref: "#/components/schemas/CreateEnvelope" },
                    { required: ["uploadId"] },
                  ],
                },
              },
              "multipart/form-data": {
                schema: {
                  properties: {
                    data: {
                      description: "CreateEnvelope as JSON, without uploadId.",
                      type: "string",
                    },
                    file: { format: "binary", type: "string" },
                  },
                  required: ["file", "data"],
                  type: "object",
                },
              },
            },
            required: true,
          },
          responses: {
            "201": envelopeResponse("The envelope, sent if send was given."),
            "413": errorResponse,
            "422": errorResponse,
            ...emailErrors,
          },
          summary: "Create an envelope, and send it if asked",
        },
      },
      "/envelopes/{id}": {
        delete: {
          parameters: [idParameter],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      deleted: { const: true, type: "boolean" },
                      id: { type: "string" },
                      object: { const: "envelope", type: "string" },
                    },
                    required: ["deleted", "id", "object"],
                    type: "object",
                  },
                },
              },
              description: "Deleted.",
            },
            ...errors,
          },
          summary: "Delete a draft",
        },
        get: {
          parameters: [idParameter],
          responses: { "200": envelopeResponse("The envelope."), ...errors },
          summary: "Get an envelope",
        },
      },
      "/envelopes/{id}/events": {
        get: {
          parameters: [idParameter],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: listOf({
                    properties: {
                      actor: {
                        properties: {
                          email: { type: ["string", "null"] },
                          type: { type: "string" },
                        },
                        type: "object",
                      },
                      at: { format: "date-time", type: "string" },
                      event: { type: "string" },
                      id: { type: "string" },
                      ipAddress: { type: ["string", "null"] },
                      metadata: { type: ["object", "null"] },
                    },
                    required: ["id", "event", "at", "actor"],
                    type: "object",
                  }),
                },
              },
              description: "The audit trail, oldest first.",
            },
            ...errors,
          },
          summary: "Get an envelope's audit trail",
        },
      },
      "/envelopes/{id}/files/{file}": {
        get: {
          parameters: [
            idParameter,
            {
              in: "path",
              name: "file",
              required: true,
              schema: { enum: ["signed", "certificate"], type: "string" },
            },
          ],
          responses: {
            "200": {
              content: { "application/pdf": {} },
              description: "The PDF.",
            },
            ...errors,
          },
          summary: "Download the signed PDF or the certificate of completion",
        },
      },
      "/envelopes/{id}/remind": {
        post: {
          parameters: [idParameter],
          responses: {
            "200": envelopeResponse("The envelope."),
            ...emailErrors,
          },
          summary: "Remind each signer whose turn it is",
        },
      },
      "/envelopes/{id}/send": {
        post: {
          parameters: [idParameter, idempotencyKey],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/SendOptions" },
              },
            },
            required: true,
          },
          responses: {
            "200": envelopeResponse("The envelope, now sent."),
            "413": errorResponse,
            "422": errorResponse,
            ...emailErrors,
          },
          summary: "Send a draft",
        },
      },
      "/envelopes/{id}/signers/{signerId}/embed-link": {
        post: {
          parameters: [
            idParameter,
            {
              in: "path",
              name: "signerId",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    origin: {
                      description:
                        "The exact origin of the page that frames the signer, such as https://app.example.com. Must be allowed in Settings.",
                      type: "string",
                    },
                  },
                  required: ["origin"],
                  type: "object",
                },
              },
            },
            required: true,
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      expiresAt: {
                        description:
                          "When the link stops working if it is not opened.",
                        format: "date-time",
                        type: "string",
                      },
                      object: { const: "embed_link", type: "string" },
                      url: {
                        description:
                          "The page to show in the frame, with its origin parameter. Use it as it is.",
                        format: "uri",
                        type: "string",
                      },
                    },
                    required: ["object", "url", "expiresAt"],
                    type: "object",
                  },
                },
              },
              description:
                "The link to frame (url) and when it stops working if not opened (expiresAt). Each call replaces the signer's last link.",
            },
            "413": errorResponse,
            ...errors,
          },
          summary:
            "Get a signing link to show in a frame, for a signer whose turn it is",
        },
      },
      "/envelopes/{id}/void": {
        post: {
          parameters: [idParameter],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    reason: { maxLength: 1000, type: ["string", "null"] },
                  },
                  type: "object",
                },
              },
            },
          },
          responses: {
            "200": envelopeResponse("The envelope, now voided."),
            "413": errorResponse,
            ...emailErrors,
          },
          summary: "Void a sent envelope",
        },
      },
      "/me": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      key: {
                        properties: {
                          id: { type: "string" },
                          name: { type: "string" },
                          scope: { enum: ["read", "write"], type: "string" },
                        },
                        type: "object",
                      },
                      user: {
                        properties: {
                          email: { type: "string" },
                          id: { type: "string" },
                          name: { type: "string" },
                        },
                        type: "object",
                      },
                    },
                    type: "object",
                  },
                },
              },
              description: "The key and its administrator.",
            },
            ...errors,
          },
          summary: "Check a key",
        },
      },
      "/openapi.json": {
        get: {
          responses: { "200": { description: "This document." } },
          security: [],
          summary: "This description",
        },
      },
      "/templates": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: listOf({ $ref: "#/components/schemas/Template" }),
                },
              },
              description: "Saved templates.",
            },
            ...errors,
          },
          summary: "List templates",
        },
      },
      "/templates/{id}/envelopes": {
        post: {
          parameters: [idParameter, idempotencyKey],
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  properties: {
                    metadata: {
                      description:
                        "Up to 2048 bytes of JSON, returned with the envelope.",
                      type: "object",
                    },
                    send: { $ref: "#/components/schemas/SendOptions" },
                    signers: {
                      description: "One per role, in the template's order.",
                      items: {
                        properties: {
                          email: { format: "email", type: "string" },
                          name: personNameSchema,
                          signatureMeaning: {
                            description: "Part 11 installs only.",
                            enum: [...signatureMeanings],
                            type: "string",
                          },
                        },
                        required: ["name", "email"],
                        type: "object",
                      },
                      maxItems: maxSigners,
                      minItems: 1,
                      type: "array",
                    },
                    title: titleSchema,
                  },
                  required: ["title", "signers"],
                  type: "object",
                },
              },
            },
            required: true,
          },
          responses: {
            "201": envelopeResponse("The new envelope."),
            "413": errorResponse,
            "422": errorResponse,
            ...emailErrors,
          },
          summary: "Create an envelope from a template",
        },
      },
      "/webhook-deliveries": {
        get: {
          parameters: [
            {
              description:
                "Only deliveries queued at or after this time, which is when their event happened, not when they were sent. Times are kept to the second, so a time with a fraction counts from the start of its second.",
              in: "query",
              name: "since",
              schema: { format: "date-time", type: "string" },
            },
            {
              in: "query",
              name: "status",
              schema: {
                enum: ["delivered", "failed", "pending"],
                type: "string",
              },
            },
            {
              in: "query",
              name: "type",
              schema: { enum: [...webhookEventTypes], type: "string" },
            },
            {
              in: "query",
              name: "limit",
              schema: {
                default: 25,
                maximum: 100,
                minimum: 1,
                type: "integer",
              },
            },
            { in: "query", name: "cursor", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    properties: {
                      data: {
                        items: { $ref: "#/components/schemas/WebhookDelivery" },
                        type: "array",
                      },
                      nextCursor: { type: ["string", "null"] },
                      object: { const: "list", type: "string" },
                    },
                    required: ["object", "data", "nextCursor"],
                    type: "object",
                  },
                },
              },
              description:
                "Webhook deliveries to every endpoint, newest first, each with the payload it carried (null until its first try).",
            },
            ...errors,
          },
          summary: "List webhook deliveries, to catch up on missed events",
        },
      },
      "/uploads": {
        post: {
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/Upload" },
                },
              },
              description:
                "Where to PUT the PDF (url, method, headers) and the uploadId to create the envelope with. Only on installs that store files in Vercel Blob.",
            },
            ...errors,
          },
          summary: "Get an upload URL for a PDF over 4 MB",
        },
      },
    },
    security: [{ apiKey: [] }],
    servers: [{ url: serverUrl }],
  };
}
