import { Suspense } from "react";
import Monitor from "@/components/Monitor";

export default function Page() {
  return (
    <Suspense
      fallback={
        <div
          className="mono flex h-screen w-screen items-center justify-center text-[11px]"
          style={{ background: "var(--ground)", color: "var(--paper-dim)" }}
        >
          LOADING…
        </div>
      }
    >
      <Monitor />
    </Suspense>
  );
}
