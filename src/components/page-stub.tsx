import type { ReactNode } from "react";

interface PageStubProps {
  title: string;
  description: string;
  children?: ReactNode;
}

export function PageStub({ title, description, children }: PageStubProps) {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
      <p className="max-w-2xl text-slate-600">{description}</p>
      {children}
      <p className="rounded-lg border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-600">
        This route is a Phase 1 shell. Its feature will be implemented in a later phase.
      </p>
    </div>
  );
}
