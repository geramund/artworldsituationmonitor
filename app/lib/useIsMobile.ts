"use client";

import { useEffect, useState } from "react";

export function useIsMobile(breakpointPx = 768): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpointPx}px)`);
    // Synchronizing with a real external system (the viewport) — there's no
    // render-time value to derive this from on the server.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsMobile(mq.matches);
    const listener = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener("change", listener);
    return () => mq.removeEventListener("change", listener);
  }, [breakpointPx]);
  return isMobile;
}
