"use client";

import { FolderInputIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { ShellButton } from "@/components/shared/form-shell";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderSelect, type FolderOption } from "./folder-select";

export function FileEnvelopeButton({
  envelopeId,
  folderId,
  folders,
}: {
  envelopeId: string;
  folderId?: string;
  folders: readonly FolderOption[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [destination, setDestination] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const label = folderId ? "Move to folder" : "File in folder";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!destination || pending) return;

    setError("");
    setPending(true);
    const fallbackError = "Unable to move the agreement.";

    try {
      const response = await fetch(
        `/api/envelopes/${encodeURIComponent(envelopeId)}/folder`,
        {
          body: JSON.stringify({ folderId: destination }),
          headers: { "content-type": "application/json" },
          method: "POST",
        },
      );

      if (!response.ok) {
        const result = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        setError(result?.error ?? fallbackError);
        return;
      }

      setOpen(false);
      router.refresh();
    } catch {
      setError(fallbackError);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <ShellButton
        onClick={() => {
          setDestination("");
          setError("");
          setOpen(true);
        }}
        variant="secondary"
      >
        <FolderInputIcon aria-hidden="true" className="size-[1.125rem]" />
        {label}
      </ShellButton>
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!pending) setOpen(value);
        }}
      >
        <DialogContent>
          <form className="space-y-4" onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
              <DialogDescription>
                Members of the destination folder can see this agreement once it
                has been sent.
              </DialogDescription>
            </DialogHeader>
            <FolderSelect
              folders={folders}
              disabled={pending}
              onChange={setDestination}
              value={destination}
            />
            {error ? (
              <div className="notice notice-danger" role="alert">
                {error}
              </div>
            ) : null}
            <div className="flex justify-end gap-2">
              <ShellButton
                disabled={pending}
                onClick={() => setOpen(false)}
                variant="secondary"
              >
                Cancel
              </ShellButton>
              <ShellButton
                disabled={!destination}
                loading={pending}
                type="submit"
              >
                {label}
              </ShellButton>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
