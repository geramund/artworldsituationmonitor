"use client";

import { useCallback, useEffect } from "react";

export interface LightboxState {
  images: string[];
  index: number;
  title: string;
  credit: string | null;
}

export interface LightboxProps {
  state: LightboxState;
  onClose: () => void;
  onNavigate: (index: number) => void;
}

export default function Lightbox({ state, onClose, onNavigate }: LightboxProps) {
  const { images, index, title, credit } = state;
  const count = images.length;

  const goPrev = useCallback(() => onNavigate((index - 1 + count) % count), [index, count, onNavigate]);
  const goNext = useCallback(() => onNavigate((index + 1) % count), [index, count, onNavigate]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && count > 1) goPrev();
      else if (e.key === "ArrowRight" && count > 1) goNext();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, goPrev, goNext, count]);

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6"
      style={{ background: "rgba(11, 12, 12, 0.92)" }}
      role="dialog"
      aria-modal="true"
      aria-label={`${title} — installation view ${index + 1} of ${count}`}
      onClick={onClose}
    >
      <button
        onClick={onClose}
        aria-label="Close image viewer"
        className="mono absolute right-4 top-4 px-2 py-1 text-[13px]"
        style={{ color: "var(--paper-dim)" }}
      >
        ESC ✕
      </button>

      {count > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goPrev();
          }}
          aria-label="Previous image"
          className="mono absolute left-2 top-1/2 -translate-y-1/2 px-3 py-4 text-[20px] sm:left-4"
          style={{ color: "var(--paper-dim)" }}
        >
          ‹
        </button>
      )}

      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={images[index]}
        alt={credit ?? title}
        className="max-h-[80vh] max-w-[90vw] object-contain"
        style={{ border: "1px solid var(--hairline)" }}
        onClick={(e) => e.stopPropagation()}
      />

      {count > 1 && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            goNext();
          }}
          aria-label="Next image"
          className="mono absolute right-2 top-1/2 -translate-y-1/2 px-3 py-4 text-[20px] sm:right-4"
          style={{ color: "var(--paper-dim)" }}
        >
          ›
        </button>
      )}

      <div
        className="mono mt-3 max-w-[90vw] text-center text-[10px]"
        style={{ color: "var(--dim)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="serif-italic" style={{ color: "var(--paper-dim)" }}>
          {title}
        </span>
        {credit && <span> · {credit}</span>}
        {count > 1 && (
          <span className="tabular">
            {" "}
            · {index + 1}/{count}
          </span>
        )}
      </div>
    </div>
  );
}
