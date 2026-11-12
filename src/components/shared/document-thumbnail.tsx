"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/cn";
import {
  backfillEnvelopeThumbnail,
  buildEnvelopeThumbnailUrl,
} from "@/lib/pdf-thumbnail";

type DocumentThumbnailProps = {
  className?: string;
  /** Leave out for a plain stand-in page. */
  envelopeId?: string;
  title: string;
};

type ThumbnailState = "drawn" | "loading" | "missing" | "stored";

/**
 * A mini version of a document's first page, with rounded corners.
 *
 * The stored picture is tried first. An envelope from before thumbnails
 * existed has none, so its first page is drawn here from the PDF and saved
 * for next time. If that cannot be done either, a stand-in page is shown.
 */
export function DocumentThumbnail({
  className,
  envelopeId,
  title,
}: DocumentThumbnailProps) {
  const [state, setState] = useState<ThumbnailState>(
    envelopeId ? "loading" : "missing",
  );
  const [drawnUrl, setDrawnUrl] = useState<string | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (drawnUrl) {
        URL.revokeObjectURL(drawnUrl);
      }
    };
  }, [drawnUrl]);

  // An image that finished loading, or failing, before React attached its
  // handlers never fires them.
  useEffect(() => {
    const image = imageRef.current;

    if (!image || !image.complete || state !== "loading") {
      return;
    }

    if (image.naturalWidth > 0) {
      setState("stored");
    } else {
      handleStoredThumbnailMissing();
    }
    // Only on mount: later changes come through the image's own events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleStoredThumbnailMissing() {
    if (!envelopeId || state !== "loading" || drawnUrl) {
      return;
    }

    backfillEnvelopeThumbnail(envelopeId)
      .then((thumbnail) => {
        if (!isMountedRef.current) {
          return;
        }

        setDrawnUrl(URL.createObjectURL(thumbnail));
        setState("drawn");
      })
      .catch(() => {
        if (isMountedRef.current) {
          setState("missing");
        }
      });
  }

  const frameClassName = cn(
    "block h-full w-auto max-w-full rounded-[0.5rem] bg-white object-contain shadow-[0_1px_2px_rgba(28,29,43,0.08),0_6px_16px_rgba(28,29,43,0.10)] ring-1 ring-[rgba(28,29,43,0.06)]",
    className,
  );

  if (state === "missing" || !envelopeId) {
    return <PagePlaceholder className={className} title={title} />;
  }

  if (state === "drawn" && drawnUrl) {
    return (
      // A blob: URL made in this browser: next/image has nothing to optimize.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        alt={`First page of ${title}`}
        className={frameClassName}
        decoding="async"
        src={drawnUrl}
      />
    );
  }

  return (
    <span className="relative flex h-full max-w-full items-center justify-center">
      {state === "loading" ? (
        <PagePlaceholder
          className={cn("animate-pulse", className)}
          title={title}
        />
      ) : null}
      {/* A private, per-account image behind a session cookie: next/image
          would fetch it from the server without that cookie. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        alt={`First page of ${title}`}
        className={
          state === "loading"
            ? "pointer-events-none absolute left-1/2 top-1/2 size-px opacity-0"
            : frameClassName
        }
        decoding="async"
        loading="lazy"
        onError={handleStoredThumbnailMissing}
        onLoad={() => setState("stored")}
        ref={imageRef}
        src={buildEnvelopeThumbnailUrl(envelopeId)}
      />
    </span>
  );
}

const placeholderLayouts = [
  { centered: true, lines: ["w-full", "w-11/12", "w-4/5", "w-full", "w-2/3"] },
  { centered: false, lines: ["w-11/12", "w-full", "w-3/4", "w-5/6", "w-1/2"] },
  { centered: true, lines: ["w-5/6", "w-full", "w-full", "w-3/5", "w-4/5"] },
] as const;

/**
 * A blank page with a few grey lines, for when there is no picture. The
 * title picks one of a few layouts so a row of them does not look stamped.
 */
function PagePlaceholder({
  className,
  title = "",
}: {
  className?: string;
  title?: string;
}) {
  const layout =
    placeholderLayouts[title.length % placeholderLayouts.length] ??
    placeholderLayouts[0];

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex aspect-[17/22] h-full flex-col gap-[7%] rounded-[0.5rem] bg-white px-[12%] py-[14%] shadow-[0_1px_2px_rgba(28,29,43,0.08),0_6px_16px_rgba(28,29,43,0.10)] ring-1 ring-[rgba(28,29,43,0.06)]",
        className,
      )}
    >
      <span
        className={cn(
          "h-[4%] w-3/5 rounded-full bg-[#cfd0dc]",
          layout.centered && "self-center",
        )}
      />
      {layout.lines.map((width, index) => (
        <span
          className={cn("h-[3%] rounded-full bg-[#e3e4ec]", width)}
          key={index}
        />
      ))}
      <span className="mt-auto h-[9%] w-2/5 rounded-[0.25rem] bg-(--accent-soft)" />
    </span>
  );
}

type SampleMark = {
  height: number;
  tone: "accent" | "body" | "heading" | "rule" | "title";
  width: number;
  x: number;
  y: number;
};

type SamplePage = {
  accent: boolean;
  centered: boolean;
  /** One entry per clause: the width of each of its lines, as a fraction. */
  clauses: readonly (readonly number[])[];
  signers: number;
};

const samplePages: readonly SamplePage[] = [
  {
    accent: false,
    centered: true,
    clauses: [
      [0.96, 0.9],
      [1, 0.72],
      [0.94, 1, 0.5],
      [1, 0.82],
      [0.97, 0.6],
    ],
    signers: 2,
  },
  {
    accent: true,
    centered: false,
    clauses: [
      [1, 0.95, 0.4],
      [0.92, 0.7],
      [1, 0.85],
      [0.96, 0.55],
    ],
    signers: 1,
  },
  {
    accent: false,
    centered: true,
    clauses: [
      [1, 0.8],
      [0.95, 1, 0.66],
      [1, 0.74],
      [0.9, 0.5],
      [1, 0.88],
      [0.97, 0.45],
    ],
    signers: 2,
  },
];

const SAMPLE_PAGE_WIDTH = 170;
const SAMPLE_PAGE_HEIGHT = 220;

const sampleMarkFills: Record<SampleMark["tone"], string> = {
  accent: "var(--accent)",
  body: "#cdcfda",
  heading: "#7d8094",
  rule: "#e1e2ea",
  title: "#3b3d4f",
};

function layoutSamplePage(sample: SamplePage): SampleMark[] {
  const left = 24;
  const textWidth = SAMPLE_PAGE_WIDTH - left * 2;
  const marks: SampleMark[] = [];
  const titleWidth = sample.centered ? 84 : 70;
  const subtitleWidth = 52;
  let y = 28;

  if (sample.accent) {
    marks.push({ height: 2.5, tone: "accent", width: 14, x: left, y: y - 8 });
  }

  marks.push({
    height: sample.centered ? 4.5 : 6,
    tone: "title",
    width: titleWidth,
    x: sample.centered ? (SAMPLE_PAGE_WIDTH - titleWidth) / 2 : left,
    y,
  });
  y += sample.centered ? 9 : 11;
  marks.push({
    height: 2.5,
    tone: "body",
    width: subtitleWidth,
    x: sample.centered ? (SAMPLE_PAGE_WIDTH - subtitleWidth) / 2 : left,
    y,
  });
  y += 7;
  marks.push({ height: 0.6, tone: "rule", width: textWidth, x: left, y });
  y += 9;

  for (const clause of sample.clauses) {
    marks.push({
      height: 2.6,
      tone: "heading",
      width: 30 + clause.length * 6,
      x: left,
      y,
    });
    y += 5.5;

    for (const fraction of clause) {
      marks.push({
        height: 2,
        tone: "body",
        width: textWidth * fraction,
        x: left,
        y,
      });
      y += 4.6;
    }

    y += 4.5;
  }

  for (let signer = 0; signer < sample.signers; signer += 1) {
    const x = left + signer * 68;

    marks.push({ height: 0.7, tone: "title", width: 52, x, y: 186 });
    marks.push({ height: 2.4, tone: "heading", width: 30, x, y: 190 });
    marks.push({ height: 1.8, tone: "body", width: 18, x, y: 195 });
  }

  marks.push({ height: 1.6, tone: "body", width: 22, x: 74, y: 206 });

  return marks;
}

const sampleLayouts = samplePages.map(layoutSamplePage);

/**
 * A drawing of a first page for places that show sample documents rather
 * than real ones, such as the dashboard preview on the landing page. The
 * seed picks one of a few layouts.
 */
export function SampleDocumentPage({
  className,
  seed = "",
}: {
  className?: string;
  seed?: string;
}) {
  const marks = sampleLayouts[seed.length % sampleLayouts.length] ?? [];

  return (
    <svg
      aria-hidden="true"
      className={cn(
        "block h-full w-auto max-w-full rounded-[0.5rem] bg-white shadow-[0_1px_2px_rgba(28,29,43,0.08),0_6px_16px_rgba(28,29,43,0.10)] ring-1 ring-[rgba(28,29,43,0.06)]",
        className,
      )}
      viewBox={`0 0 ${String(SAMPLE_PAGE_WIDTH)} ${String(SAMPLE_PAGE_HEIGHT)}`}
    >
      {marks.map((mark, index) => (
        <rect
          fill={sampleMarkFills[mark.tone]}
          height={mark.height}
          key={index}
          rx={Math.min(mark.height / 2, 1.2)}
          width={mark.width}
          x={mark.x}
          y={mark.y}
        />
      ))}
    </svg>
  );
}
