import { Suspense } from "react";
import CommandCenter from "@/components/CommandCenter";

export default function Home() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted">Loading Chaser...</div>}>
      <CommandCenter />
    </Suspense>
  );
}
