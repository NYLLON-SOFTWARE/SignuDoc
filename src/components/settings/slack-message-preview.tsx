"use client";

import type { ReactNode } from "react";

import type {
  SlackAttachment,
  SlackBlock,
  SlackMessageContent,
} from "@/lib/notifications/slack/client";

// A Slack message drawn the way Slack draws it: the app's square picture,
// its name in bold with the APP badge and the time, then the message's
// blocks and its coloured attachments. It reads the same Block Kit payload
// that is sent, so the settings page shows exactly what people will get.
// Only what notifications use is drawn: context, section and actions
// blocks; mrkdwn bold, links, dates and emoji.

const EMOJI: Record<string, string> = {
  alarm_clock: "⏰",
  ballot_box_with_check: "☑️",
  eyes: "\u{1F440}",
  hourglass: "⌛",
  hourglass_flowing_sand: "⏳",
  no_entry: "⛔",
  no_entry_sign: "\u{1F6AB}",
  outbox_tray: "\u{1F4E4}",
  warning: "⚠️",
  white_check_mark: "✅",
  writing_hand: "✍️",
  x: "❌",
};

function decode(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const TOKEN =
  /<!date\^\d+\^[^|>]*\|([^>]*)>|<(https?:\/\/[^|>]+)\|([^>]+)>|\*([^*\n]+)\*|:([a-z0-9_+-]+):/g;

/** Slack's mrkdwn, as far as notifications use it. */
function Mrkdwn({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  let last = 0;

  for (const match of text.matchAll(TOKEN)) {
    const index = match.index ?? 0;

    if (index > last) {
      parts.push(decode(text.slice(last, index)));
    }

    const [whole, dateFallback, url, label, bold, emoji] = match;
    const key = `${String(index)}-${whole.length}`;

    if (dateFallback !== undefined) {
      parts.push(decode(dateFallback));
    } else if (url !== undefined) {
      parts.push(
        <span className="text-[#1264a3]" key={key}>
          {decode(label ?? url)}
        </span>,
      );
    } else if (bold !== undefined) {
      parts.push(
        <strong className="font-bold" key={key}>
          {decode(bold)}
        </strong>,
      );
    } else if (emoji !== undefined) {
      parts.push(EMOJI[emoji] ?? whole);
    }

    last = index + whole.length;
  }

  if (last < text.length) {
    parts.push(decode(text.slice(last)));
  }

  return <>{parts}</>;
}

type TextObject = { text?: string; type?: string };

function textOf(value: unknown): string {
  return typeof value === "object" && value !== null
    ? String((value as TextObject).text ?? "")
    : "";
}

function Block({ block }: { block: SlackBlock }) {
  if (block.type === "section") {
    return (
      <p className="text-[15px] leading-[22px] text-[#1d1c1d]">
        <Mrkdwn text={textOf(block.text)} />
      </p>
    );
  }

  if (block.type === "context") {
    const elements = Array.isArray(block.elements)
      ? (block.elements as SlackBlock[])
      : [];

    return (
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] leading-[18px] text-[#616061]">
        {elements.map((element, index) =>
          element.type === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element -- a picture from this site, drawn as Slack would
            <img
              alt=""
              className="size-4 rounded-[3px] object-contain"
              key={index}
              src={String(element.image_url ?? "")}
            />
          ) : (
            <span key={index}>
              <Mrkdwn text={String(element.text ?? "")} />
            </span>
          ),
        )}
      </div>
    );
  }

  if (block.type === "actions") {
    const elements = Array.isArray(block.elements)
      ? (block.elements as SlackBlock[])
      : [];

    return (
      <div className="flex flex-wrap gap-2 pt-1">
        {elements.map((element, index) => (
          <span
            className={
              element.style === "primary"
                ? "inline-flex h-7 items-center rounded-[4px] bg-[#007a5a] px-3 text-[13px] font-bold text-white"
                : "inline-flex h-7 items-center rounded-[4px] border border-[#1d1c1d]/30 bg-white px-3 text-[13px] font-bold text-[#1d1c1d]"
            }
            key={index}
          >
            {textOf(element.text)}
          </span>
        ))}
      </div>
    );
  }

  return null;
}

function Attachment({ attachment }: { attachment: SlackAttachment }) {
  return (
    <div className="mt-1 flex gap-3">
      <span
        aria-hidden="true"
        className="w-1 shrink-0 rounded-full"
        style={{ background: attachment.color }}
      />
      <div className="min-w-0 space-y-1.5 py-0.5">
        {attachment.blocks.map((block, index) => (
          <Block block={block} key={index} />
        ))}
      </div>
    </div>
  );
}

export function SlackMessagePreview({
  appName,
  content,
  iconUrl,
  time = "9:41 AM",
}: {
  appName: string;
  content: SlackMessageContent;
  iconUrl: string;
  time?: string;
}) {
  const blocks = content.blocks ?? [];

  return (
    <div
      className="flex gap-2 rounded-lg bg-white px-4 py-3 font-[Lato,ui-sans-serif,system-ui,sans-serif] antialiased"
      role="img"
      aria-label={`Slack message from ${appName}: ${content.text}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- the app's own icon, as Slack shows it */}
      <img
        alt=""
        className="size-9 shrink-0 rounded-md object-cover"
        src={iconUrl}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-[15px] font-black text-[#1d1c1d]">
            {appName}
          </span>
          <span className="rounded-[3px] bg-[#1d1c1d]/[0.08] px-1 text-[10px] font-bold leading-4 text-[#616061]">
            APP
          </span>
          <span className="text-[12px] text-[#616061]">{time}</span>
        </div>
        <div className="space-y-1">
          {blocks.length > 0 ? (
            blocks.map((block, index) => <Block block={block} key={index} />)
          ) : (
            <p className="text-[15px] leading-[22px] text-[#1d1c1d]">
              <Mrkdwn text={content.text} />
            </p>
          )}
          {(content.attachments ?? []).map((attachment, index) => (
            <Attachment attachment={attachment} key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}
