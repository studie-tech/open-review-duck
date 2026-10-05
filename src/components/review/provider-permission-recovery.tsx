"use client";

import { CircleAlert, ExternalLink, KeyRound, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { startHostedProviderAuthorization } from "~/lib/hosted-provider-authorization";
import { providerLabel } from "~/lib/provider-labels";
import {
  type ProviderConnectionRecovery,
  type ProviderPermissionKind,
  type ProviderPermissionName,
  providerPermissionRecovery,
  providerSettingsHref,
} from "~/lib/provider-permission-recovery";

/** Guides a reviewer from a blocked provider action to updated permissions. */
export function ProviderPermissionRecovery({
  kind,
  provider,
  connection,
  pullRequestUrl,
  reviewPath,
  personalAccount = false,
}: {
  kind: ProviderPermissionKind;
  provider: ProviderPermissionName;
  connection?: ProviderConnectionRecovery;
  pullRequestUrl: string;
  reviewPath?: string;
  personalAccount?: boolean;
}) {
  const [reconnectPending, setReconnectPending] = useState(false);
  const baseRecovery = providerPermissionRecovery(provider, kind, connection);
  const recovery = personalAccount
    ? {
        ...baseRecovery,
        title: `Your ${providerLabel(provider)} account cannot submit this review`,
        description:
          "Update your personal account's review permissions, then reconnect it. Your workspace connection and comment posting preference stay unchanged.",
        settingsLabel: `Reconnect my ${providerLabel(provider)} account`,
        settingsHref: connection
          ? providerSettingsHref(connection.connectionId)
          : "/settings/providers",
        reconnect: Boolean(
          connection?.canReconnect && provider !== "azure_devops",
        ),
      }
    : baseRecovery;

  /** Restarts hosted authorization and returns the reviewer to this pull request. */
  async function reconnect() {
    if (!recovery.reconnect || provider === "azure_devops") return;
    setReconnectPending(true);
    try {
      if (personalAccount && connection) {
        await startHostedProviderAuthorization(
          provider,
          reviewPath ?? "/settings/providers",
          undefined,
          {
            purpose: "user_identity",
            connectionId: connection.connectionId,
          },
        );
      } else {
        await startHostedProviderAuthorization(
          provider,
          reviewPath ?? "/settings/providers",
        );
      }
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
