"use client";

import { CircleAlert, ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import {
  type ProviderConnectionRecovery,
  type ProviderPermissionKind,
  type ProviderPermissionName,
  providerPermissionRecovery,
} from "~/lib/provider-permission-recovery";

/** Guides a reviewer from a blocked provider action to updated permissions. */
export function ProviderPermissionRecovery({
  kind,
  provider,
  connection,
  pullRequestUrl,
  reviewPath,
}: {
  kind: ProviderPermissionKind;
  provider: ProviderPermissionName;
  connection?: ProviderConnectionRecovery;
  pullRequestUrl: string;
  reviewPath?: string;
}) {
  const [reconnectPending, setReconnectPending] = useState(false);
  const recovery = providerPermissionRecovery(provider, kind, connection);

  /** Restarts hosted authorization and returns the reviewer to this pull request. */
  async function reconnect() {
    if (!recovery.reconnect) return;
    setReconnectPending(true);
    try {
      const response = await fetch(`/api/integrations/${provider}/start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirectPath: reviewPath ?? "/settings/providers",
        }),
      });
      const result = (await response.json()) as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error ?? "Authorization could not be started");
      }
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setReconnectPending(false);
      toast.error(
        cause instanceof Error ? cause.message : "Authorization failed",
      );
    }
  }

  return (
    <div
      role="alert"
      className="border-coral/25 bg-coral/[.055] mt-4 rounded-xl border px-3 py-3"
    >
      <div className="flex items-start gap-2.5">
        <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
        <div className="min-w-0">
          <p className="text-cloud text-xs font-medium">{recovery.title}</p>
          <p className="text-mist mt-1 text-[10px] leading-4">
            {recovery.description}
          </p>
          <p className="text-fog mt-2 text-[10px]">
            Required access:{" "}
            <span className="text-cloud">{recovery.requiredAccess}</span>
          </p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {recovery.reconnect ? (
          <Button
            type="button"
            size="sm"
            disabled={reconnectPending}
            onClick={() => void reconnect()}
          >
            {reconnectPending ? (
              <RefreshCw className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {recovery.settingsLabel}
          </Button>
        ) : (
          <Button asChild size="sm">
            <Link href={recovery.settingsHref}>
              <KeyRound className="size-3.5" />
              {recovery.settingsLabel}
            </Link>
          </Button>
        )}
        <Button asChild size="sm" variant="secondary">
          <a href={pullRequestUrl} target="_blank" rel="noreferrer">
            {recovery.finishLabel}
            <ExternalLink className="size-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}
