import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildEnvelopeOriginalPdfKey,
  buildEnvelopeThumbnailKey,
} from "./storage-keys.ts";

const envelopeId = "0b7f6f0e-2f6a-4d0c-9a53-3f0e7c1f9a11";

test("the picture sits beside the original", () => {
  const sourcePdfKey = buildEnvelopeOriginalPdfKey({
    envelopeId,
    userId: "sender",
  });

  assert.equal(
    buildEnvelopeThumbnailKey({ envelopeId, sourcePdfKey, userId: "sender" }),
    `users/sender/envelopes/${envelopeId}/thumbnail.jpg`,
  );
});

test("the picture stays where the files are when the envelope changes hands", () => {
  const sourcePdfKey = buildEnvelopeOriginalPdfKey({
    envelopeId,
    userId: "sender",
  });

  assert.equal(
    buildEnvelopeThumbnailKey({ envelopeId, sourcePdfKey, userId: "keeper" }),
    `users/sender/envelopes/${envelopeId}/thumbnail.jpg`,
  );
});

test("an original in a shared folder does not share its picture", () => {
  assert.equal(
    buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey: "imports/batch-7/contract.pdf",
      userId: "sender",
    }),
    `users/sender/envelopes/${envelopeId}/thumbnail.jpg`,
  );
  assert.equal(
    buildEnvelopeThumbnailKey({
      envelopeId,
      sourcePdfKey: "contract.pdf",
      userId: "sender",
    }),
    `users/sender/envelopes/${envelopeId}/thumbnail.jpg`,
  );
});
