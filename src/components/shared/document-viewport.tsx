"use client";

import { type PointerEvent as ReactPointerEvent } from "react";

export type DocumentPanGesture = {
  hasMoved: boolean;
  pointerId: number;
  startClientX: number;
  startClientY: number;
  startScrollLeft: number;
  startScrollTop: number;
};

export const DEFAULT_DOCUMENT_ZOOM_LEVEL = 1;
export const DOCUMENT_ZOOM_STEP = 0.1;

const DOCUMENT_PAN_THRESHOLD_PX = 6;
const MAX_DOCUMENT_ZOOM_LEVEL = 2;
const MIN_DOCUMENT_ZOOM_LEVEL = 0.6;

function roundNormalized(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function clampDocumentZoomLevel(value: number) {
  return Math.min(
    MAX_DOCUMENT_ZOOM_LEVEL,
    Math.max(MIN_DOCUMENT_ZOOM_LEVEL, roundNormalized(value)),
  );
}

export function beginDocumentPanGesture(input: {
  canStart?: boolean;
  event: ReactPointerEvent<HTMLDivElement>;
  scrollContainer: HTMLDivElement | null;
  shouldIgnoreTarget?: (target: HTMLElement) => boolean;
  zoomLevel: number;
}): DocumentPanGesture | null {
  if (
    input.canStart === false ||
    input.zoomLevel <= DEFAULT_DOCUMENT_ZOOM_LEVEL ||
    input.event.button !== 0
  ) {
    return null;
  }

  const target = input.event.target;
  const scrollContainer = input.scrollContainer;

  if (!(scrollContainer instanceof HTMLDivElement)) {
    return null;
  }

  if (
    !(target instanceof HTMLElement) ||
    input.shouldIgnoreTarget?.(target) === true
  ) {
    return null;
  }

  const canPanHorizontally =
    scrollContainer.scrollWidth > scrollContainer.clientWidth;
  const canPanVertically =
    scrollContainer.scrollHeight > scrollContainer.clientHeight;

  if (!canPanHorizontally && !canPanVertically) {
    return null;
  }

  if (typeof scrollContainer.setPointerCapture === "function") {
    scrollContainer.setPointerCapture(input.event.pointerId);
  }

  return {
    hasMoved: false,
    pointerId: input.event.pointerId,
    startClientX: input.event.clientX,
    startClientY: input.event.clientY,
    startScrollLeft: scrollContainer.scrollLeft,
    startScrollTop: scrollContainer.scrollTop,
  };
}

export function moveDocumentPanGesture(input: {
  event: ReactPointerEvent<HTMLDivElement>;
  gesture: DocumentPanGesture | null;
  onPanStart: () => void;
  scrollContainer: HTMLDivElement | null;
}) {
  const scrollContainer = input.scrollContainer;
  const gesture = input.gesture;

  if (
    !(scrollContainer instanceof HTMLDivElement) ||
    !gesture ||
    input.event.pointerId !== gesture.pointerId
  ) {
    return;
  }

  const deltaX = input.event.clientX - gesture.startClientX;
  const deltaY = input.event.clientY - gesture.startClientY;

  if (
    !gesture.hasMoved &&
    Math.hypot(deltaX, deltaY) < DOCUMENT_PAN_THRESHOLD_PX
  ) {
    return;
  }

  input.event.preventDefault();

  if (!gesture.hasMoved) {
    gesture.hasMoved = true;
    input.onPanStart();
  }

  scrollContainer.scrollLeft = gesture.startScrollLeft - deltaX;
  scrollContainer.scrollTop = gesture.startScrollTop - deltaY;
}

export function endDocumentPanGesture(input: {
  event: ReactPointerEvent<HTMLDivElement>;
  gesture: DocumentPanGesture | null;
  onPanEnd: () => void;
  scrollContainer: HTMLDivElement | null;
}): boolean {
  const scrollContainer = input.scrollContainer;
  const gesture = input.gesture;

  if (
    !(scrollContainer instanceof HTMLDivElement) ||
    !gesture ||
    input.event.pointerId !== gesture.pointerId
  ) {
    return false;
  }

  if (typeof scrollContainer.releasePointerCapture === "function") {
    scrollContainer.releasePointerCapture(input.event.pointerId);
  }

  if (gesture.hasMoved) {
    input.onPanEnd();
  }

  return true;
}

export function DocumentZoomControls({
  onDecrease,
  onIncrease,
  onReset,
  zoomLevel,
}: {
  onDecrease: () => void;
  onIncrease: () => void;
  onReset: () => void;
  zoomLevel: number;
}) {
  const zoomPercentage = Math.round(zoomLevel * 100);

  return (
    <div className="inline-flex min-h-11 items-center gap-0.5 rounded-xl bg-(--surface) p-1">
      <button
        aria-label="Zoom out"
        className="inline-flex size-9 items-center justify-center rounded-[0.5625rem] text-lg leading-none text-(--fg) transition hover:bg-white disabled:text-(--placeholder) disabled:hover:bg-transparent"
        disabled={zoomLevel <= MIN_DOCUMENT_ZOOM_LEVEL}
        onClick={onDecrease}
        type="button"
      >
        -
      </button>
      <div className="flex min-w-[58px] items-center justify-center px-1 text-sm font-semibold tabular-nums text-(--fg)">
        {zoomPercentage}%
      </div>
      <button
        aria-label="Zoom in"
        className="inline-flex size-9 items-center justify-center rounded-[0.5625rem] text-lg leading-none text-(--fg) transition hover:bg-white disabled:text-(--placeholder) disabled:hover:bg-transparent"
        disabled={zoomLevel >= MAX_DOCUMENT_ZOOM_LEVEL}
        onClick={onIncrease}
        type="button"
      >
        +
      </button>
      <button
        className="inline-flex min-h-9 items-center justify-center rounded-[0.5625rem] px-3 text-[0.8125rem] font-semibold text-(--secondary) transition hover:bg-white hover:text-(--fg)"
        onClick={onReset}
        type="button"
      >
        Fit
      </button>
    </div>
  );
}
