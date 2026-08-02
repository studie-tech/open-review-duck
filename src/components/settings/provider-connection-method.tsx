"use client";

import { KeyRound, ShieldCheck } from "lucide-react";
import type { CodeProvider } from "./provider-token-guide";

export type ProviderConnectionMethod = "managed" | "pat";

const managedLabels: Record<CodeProvider, string> = {
  github: "GitHub App",
  gitlab: "GitLab OAuth",
  azure_devops: "Microsoft Entra",
};

/** Lets a SaaS administrator choose managed authorization or an encrypted PAT. */
export function ProviderConnectionMethodPicker({
  method,
  onChange,
  provider,
}: {
  method: ProviderConnectionMethod;
  onChange: (method: ProviderConnectionMethod) => void;
  provider: CodeProvider;
}) {
  return (
    <div className="mt-6">
      <p className="text-fog text-[10px] font-semibold tracking-[.14em] uppercase">
        Connection method
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          aria-pressed={method === "managed"}
          onClick={() => onChange("managed")}
          className={`rounded-2xl border p-4 text-left transition ${
            method === "managed"
              ? "border-cyan/35 bg-cyan/[.055]"
              : "border-line bg-surface/70 hover:bg-surface-hover"
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-sm font-medium">
              <ShieldCheck className="text-cyan size-4" />
              {managedLabels[provider]}
            </span>
            {provider !== "azure_devops" && (
              <span className="border-cyan/20 bg-cyan/[.06] text-cyan rounded-full border px-2 py-0.5 text-[9px] font-semibold tracking-wide uppercase">
                Recommended
              </span>
            )}
          </div>
          <p className="text-mist mt-2 text-[11px] leading-5">
            Authorize on the provider and revoke access there at any time.
          </p>
        </button>
        <button
          type="button"
          aria-pressed={method === "pat"}
          onClick={() => onChange("pat")}
          className={`rounded-2xl border p-4 text-left transition ${
            method === "pat"
              ? "border-coral/35 bg-coral/[.055]"
              : "border-line bg-surface/70 hover:bg-surface-hover"
          }`}
        >
          <span className="flex items-center gap-2 text-sm font-medium">
            <KeyRound className="text-coral size-4" />
            Personal access token
          </span>
          <p className="text-mist mt-2 text-[11px] leading-5">
            {provider === "azure_devops"
              ? "Use your existing Azure DevOps permissions without asking a tenant admin to approve an application."
              : "Use this when organization policy prevents App or OAuth authorization."}
          </p>
        </button>
      </div>
    </div>
  );
}
