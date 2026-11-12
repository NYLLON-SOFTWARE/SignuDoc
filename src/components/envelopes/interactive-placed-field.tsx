"use client";

import { useRef, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";

import { type FieldResizeHandle } from "@/lib/utils/pdf-coords";

const dragThresholdPx = 4;
const compactFieldHeightThreshold = 0.045;
const compactFieldWidthThreshold = 0.12;

const resizeHandles: ReadonlyArray<{
  corner: FieldResizeHandle;
  cursorClassName: string;
  positionClassName: string;
}> = [
  {
    corner: "top-left",
    cursorClassName: "cursor-nwse-resize",
    positionClassName: "-left-2 -top-2",
  },
  {
    corner: "top-right",
    cursorClassName: "cursor-nesw-resize",
    positionClassName: "-right-2 -top-2",
  },
  {
    corner: "bottom-left",
    cursorClassName: "cursor-nesw-resize",
    positionClassName: "-bottom-2 -left-2",
  },
  {
    corner: "bottom-right",
    cursorClassName: "cursor-nwse-resize",
    positionClassName: "-bottom-2 -right-2",
  },
] as const;

type InteractivePlacedFieldProps = {
  coordinateScale: number;
  field: {
    height: number;
    required: boolean;
    type: string;
    width: number;
    x: number;
    y: number;
  };
  isSelected: boolean;
  label: string;
  onInteractionChange?: (isActive: boolean) => void;
  onMove: (deltaX: number, deltaY: number) => void;
  onResize: (corner: FieldResizeHandle, deltaX: number, deltaY: number) => void;
  onSelect: () => void;
  signer: {
    color: string;
    name: string;
    tint: string;
  };
};

type PointerGesture = {
  corner?: FieldResizeHandle;
  hasMoved: boolean;
  lastClientX: number;
  lastClientY: number;
  pointerId: number;
  target: HTMLElement;
  type: "move" | "resize";
  viewportHeight: number;
  viewportWidth: number;
};

export function InteractivePlacedField({
  coordinateScale,
  field,
  isSelected,
  label,
  onInteractionChange,
  onMove,
  onResize,
  onSelect,
  signer,
}: InteractivePlacedFieldProps) {
  const gestureRef = useRef<PointerGesture | null>(null);
  const percentMultiplier = 100 / coordinateScale;
  const isRadio = field.type === "radio";
  const isCheckbox = field.type === "checkbox" || isRadio;
  const showInlineLabel =
    !isCheckbox &&
    field.width >= compactFieldWidthThreshold &&
    field.height >= compactFieldHeightThreshold;

  function beginGesture(
    event: ReactPointerEvent<HTMLElement>,
    type: PointerGesture["type"],
    corner?: FieldResizeHandle,
  ) {
    if (event.button !== 0) {
      return;
    }

    const viewport = event.currentTarget.closest("[data-field-viewport]");

    if (!(viewport instanceof HTMLElement)) {
      return;
    }

    const viewportRect = viewport.getBoundingClientRect();

    if (viewportRect.width === 0 || viewportRect.height === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onSelect();

    if (typeof event.currentTarget.setPointerCapture === "function") {
      event.currentTarget.setPointerCapture(event.pointerId);
    }

    gestureRef.current = {
      corner,
      hasMoved: false,
      lastClientX: event.clientX,
      lastClientY: event.clientY,
      pointerId: event.pointerId,
      target: event.currentTarget,
      type,
      viewportHeight: viewportRect.height,
      viewportWidth: viewportRect.width,
    };
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;

    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }

    const deltaClientX = event.clientX - gesture.lastClientX;
    const deltaClientY = event.clientY - gesture.lastClientY;

    if (
      !gesture.hasMoved &&
      Math.hypot(
        event.clientX - gesture.lastClientX,
        event.clientY - gesture.lastClientY,
      ) < dragThresholdPx
    ) {
      return;
    }

    event.preventDefault();

    if (!gesture.hasMoved) {
      gesture.hasMoved = true;
      onInteractionChange?.(true);
    }

    const scaledDeltaX = (deltaClientX / gesture.viewportWidth) * coordinateScale;
    const scaledDeltaY =
      (deltaClientY / gesture.viewportHeight) * coordinateScale;

    if (gesture.type === "move") {
      onMove(scaledDeltaX, scaledDeltaY);
    } else if (gesture.corner) {
      onResize(gesture.corner, scaledDeltaX, scaledDeltaY);
    }

    gesture.lastClientX = event.clientX;
    gesture.lastClientY = event.clientY;
  }

  function endGesture(event: ReactPointerEvent<HTMLElement>) {
    const gesture = gestureRef.current;

    if (!gesture || event.pointerId !== gesture.pointerId) {
      return;
    }

    event.preventDefault();

    if (typeof gesture.target.releasePointerCapture === "function") {
      gesture.target.releasePointerCapture(event.pointerId);
    }

    if (gesture.hasMoved) {
      onInteractionChange?.(false);
    }

    gestureRef.current = null;
  }

  function handleKeyboardSelect(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }

    event.preventDefault();
    onSelect();
  }

  return (
    <div
      aria-label={`${signer.name} · ${label}`}
      aria-pressed={isSelected}
      className={`absolute z-2 flex touch-none select-none items-center justify-center overflow-visible border-2 text-center text-[11px] font-semibold shadow-(--shadow-card) transition ${
        isSelected
          ? "ring-4 ring-[rgba(28,29,43,0.10)]"
          : "hover:ring-2 hover:ring-[rgba(28,29,43,0.08)]"
      } cursor-grab ${isRadio ? "rounded-full p-0" : isCheckbox ? "rounded-[0.25rem] p-0" : "rounded-[0.375rem] px-2 py-1"}`}
      onKeyDown={handleKeyboardSelect}
      onPointerCancel={endGesture}
      onPointerDown={(event) => beginGesture(event, "move")}
      onPointerMove={handlePointerMove}
      onPointerUp={endGesture}
      role="button"
      data-placed-field="true"
      style={{
        backgroundColor: signer.tint,
        borderColor: signer.color,
        color: signer.color,
        height: `${field.height * percentMultiplier}%`,
        left: `${field.x * percentMultiplier}%`,
        top: `${field.y * percentMultiplier}%`,
        width: `${field.width * percentMultiplier}%`,
      }}
      tabIndex={0}
    >
      {showInlineLabel ? (
        <span className="pointer-events-none max-w-full overflow-hidden text-ellipsis whitespace-nowrap px-1">
          {label}
        </span>
      ) : null}

      {isSelected
        ? resizeHandles.map((handle) => (
            <button
              aria-label={`Resize ${label} field from ${handle.corner}`}
              className={`absolute ${handle.positionClassName} ${handle.cursorClassName} z-1 size-4 rounded-full bg-white shadow-[0_4px_10px_rgba(28,29,43,0.18)]`}
              key={handle.corner}
              onPointerCancel={endGesture}
              onPointerDown={(event) => beginGesture(event, "resize", handle.corner)}
              onPointerMove={handlePointerMove}
              onPointerUp={endGesture}
              style={{
                border: `2px solid ${signer.color}`,
              }}
              tabIndex={-1}
              type="button"
            />
          ))
        : null}
    </div>
  );
}
