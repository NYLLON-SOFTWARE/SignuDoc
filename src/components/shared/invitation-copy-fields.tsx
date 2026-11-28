"use client";

import { Textarea } from "@/components/ui/textarea";
import {
  MAX_INVITATION_MESSAGE_LENGTH,
  MAX_INVITATION_SUBJECT_LENGTH,
  type InvitationCopy,
} from "@/lib/schemas/invitation";

type InvitationCopyFieldsProps = {
  disabled?: boolean;
  onChange: (invitation: InvitationCopy) => void;
  value: InvitationCopy;
};

export function InvitationCopyFields({
  disabled,
  onChange,
  value,
}: InvitationCopyFieldsProps) {
  return (
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="text-[0.8125rem] font-semibold text-(--secondary)">
          Email subject (optional)
        </span>
        <input
          className="field-input"
          disabled={disabled}
          maxLength={MAX_INVITATION_SUBJECT_LENGTH}
          onChange={(event) =>
            onChange({ ...value, subject: event.target.value })
          }
          type="text"
          value={value.subject ?? ""}
        />
      </label>
      <label className="grid gap-1.5">
        <span className="text-[0.8125rem] font-semibold text-(--secondary)">
          Email message (optional)
        </span>
        <Textarea
          className="min-h-20"
          disabled={disabled}
          maxLength={MAX_INVITATION_MESSAGE_LENGTH}
          onChange={(event) =>
            onChange({ ...value, message: event.target.value })
          }
          rows={3}
          value={value.message ?? ""}
        />
      </label>
    </div>
  );
}
