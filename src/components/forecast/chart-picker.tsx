"use client";

import { useRef, useState } from "react";

export type PickerDay = {
  /** "Dec 12, 2026" */
  date: string;
  /** "$1,234.56" */
  balance: string;
  /** "Rent -$1,200.00", already formatted. */
  items: string[];
  /** Where the day sits on the plot, as percentages of its width and height. */
  left: number;
  top: number;
  past: boolean;
};

const KEY_STEPS: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, PageUp: -7, PageDown: 7 };

/**
 * Lets a person point at one day of the chart: hover, tap or drag across it, or
 * focus it and use the arrow keys. The plot itself is drawn on the server; this
 * only lays a pointer surface over it and says what the chosen day holds.
 */
export function ChartPicker({
  days,
  start,
  edge,
  children,
}: {
  days: readonly PickerDay[];
  /** The day the keyboard starts from (today). */
  start: number;
  /** The plot's side padding, as a fraction of its width. */
  edge: number;
  children: React.ReactNode;
}) {
  const [picked, setPicked] = useState<number | null>(null);
  const dragging = useRef(false);
  const last = days.length - 1;
  const day = picked === null ? null : days[picked];

  function pick(event: React.PointerEvent<HTMLDivElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0) return;
    const across = ((event.clientX - box.left) / box.width - edge) / (1 - 2 * edge);
    setPicked(Math.min(last, Math.max(0, Math.floor(across * days.length))));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const from = picked ?? start;
    let next: number;
    if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key in KEY_STEPS) next = picked === null ? start : from + KEY_STEPS[event.key];
    else return;
    event.preventDefault();
    setPicked(Math.min(last, Math.max(0, next)));
  }

  return (
    <>
      <div className="chart-canvas">
        {children}
        {day && (
          <>
            <span className="chart-cursor" style={{ left: `${day.left}%` }} aria-hidden="true" />
            <span className="chart-dot" style={{ left: `${day.left}%`, top: `${day.top}%` }} aria-hidden="true" />
          </>
        )}
        <div
          className="chart-pick"
          role="slider"
          tabIndex={0}
          aria-label="Day"
          aria-valuemin={0}
          aria-valuemax={last}
          aria-valuenow={picked ?? start}
          aria-valuetext={day ? `${day.date}: ${day.balance}` : "No day chosen"}
          onKeyDown={onKeyDown}
          onPointerDown={(event) => {
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            pick(event);
          }}
          onPointerMove={(event) => {
            if (dragging.current || event.pointerType === "mouse") pick(event);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
        />
      </div>
      <p className="chart-readout">
        {day ? (
          <>
            <strong>{day.date}</strong> <span className="chart-readout-balance">{day.balance}</span>
            {day.past && <span className="muted"> · actual</span>}
            {day.items.length > 0 && <span className="muted"> · {day.items.join(" · ")}</span>}
          </>
        ) : (
          <span className="muted">Tap or drag on the chart to see a day.</span>
        )}
      </p>
    </>
  );
}
