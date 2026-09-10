"use client";

import { CircleAlert, Loader2, UserRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { modalSurfaceClassName } from "~/components/ui/modal-surface";
import { startHostedProviderAuthorization } from "~/lib/hosted-provider-authorization";
import { supportsManagedReauthorization } from "~/lib/provider-credential-recovery";
import { providerLabel } from "~/lib/provider-labels";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

/** Workspace-level choice plus per-connection personal provider identities. */
export function CommentIdentity({ localMode }: { localMode: boolean }) {
  const utils = api.useUtils();
  const identity = api.provider.commentIdentity.useQuery();
  const save = api.provider.saveCommentIdentity.useMutation({
    onSuccess: async () => {
      await utils.provider.commentIdentity.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });
  const disconnect = api.provider.disconnectPersonalCredential.useMutation({
    onSuccess: async ({ remoteRevokeComplete }) => {
      await utils.provider.commentIdentity.invalidate();
      if (remoteRevokeComplete) {
        toast.success("Personal account disconnected");
      } else {
        toast.warning(
          "Personal account disconnected locally. The provider could not confirm revocation; revoke access in the provider's settings.",
        );
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [patConnectionId, setPatConnectionId] = useState<string>();

  if (!identity.data || identity.data.connections.length === 0) {
    return null;
  }

  const { publishAsSelf, connections } = identity.data;
  const missing = connections.filter((connection) => !connection.identity);

  return (
    <section
      aria-labelledby="comment-identity-heading"
      className="bg-surface/70 overflow-hidden rounded-2xl border border-line"
    >
      <div className="grid gap-3 px-5 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start sm:gap-6 sm:px-6">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2">
            <span
              id="comment-identity-heading"
              className="text-cloud text-sm font-medium"
            >
              Post comments as myself
            </span>
          </p>
          <p className="text-mist mt-1 text-xs leading-5">
            Comments, replies, and review decisions appear under your provider
            account instead of ReviewDuck. Leave this off to keep posting as the
            shared workspace connection.
          </p>
        </div>
        <label className="inline-flex shrink-0 items-center gap-2 sm:mt-0.5">
          <span className="sr-only">Post comments as myself</span>
          <span className="relative inline-flex">
            <input
              type="checkbox"
              checked={publishAsSelf}
              disabled={save.isPending}
              onChange={(event) =>
                save.mutate({ publishAsSelf: event.target.checked })
              }
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="bg-surface-subtle peer-checked:bg-lime peer-focus-visible:ring-lime/55 peer-disabled:opacity-45 block h-6 w-10 rounded-full border border-line transition peer-checked:border-lime peer-focus-visible:ring-2 peer-focus-visible:ring-offset-2 peer-focus-visible:ring-offset-ink peer-disabled:cursor-not-allowed"
            />
            <span
              aria-hidden="true"
              className="bg-cloud pointer-events-none absolute top-0.5 left-0.5 size-5 rounded-full shadow-sm transition peer-checked:translate-x-4 peer-checked:bg-accent-foreground peer-disabled:opacity-45"
            />
          </span>
        </label>
      </div>

      <div className="divide-y divide-line border-t border-line">
        {publishAsSelf && missing.length > 0 && (
          <p className="text-mist flex items-start gap-2 px-5 py-3 text-xs leading-5 sm:px-6">
            <CircleAlert className="text-coral mt-0.5 size-3.5 shrink-0" />
            Connect your account on each provider below. Posts stay blocked
            until that identity is connected.
          </p>
        )}
        {connections.map((connection) => {
          const pending =
            authorizationPending || disconnect.isPending || save.isPending;
          const canReconnect = supportsManagedReauthorization(
            localMode,
            connection.credentialKind,
            connection.provider,
          );
          return (
            <div
              key={connection.connectionId}
              className="flex flex-wrap items-center gap-3 px-5 py-4 sm:px-6"
            >
              <span className="bg-lime/10 text-lime grid size-9 place-items-center rounded-xl">
                <UserRound className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-cloud text-sm font-medium">
                  {providerLabel(connection.provider)} ·{" "}
                  {connection.displayName}
                </p>
                <p className="text-mist mt-0.5 text-xs">
                  {connection.identity
                    ? `Connected as ${connection.identity.displayLogin}`
                    : publishAsSelf
                      ? "Not connected — connect this account to post as yourself"
                      : "Not connected — posts still appear as ReviewDuck"}
                </p>
              </div>
              {connection.identity ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() =>
                    disconnect.mutate({
                      connectionId: connection.connectionId,
                    })
                  }
                >
                  {disconnect.isPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Disconnect
                </Button>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {canReconnect &&
                    (connection.provider === "github" ||
                      connection.provider === "gitlab") && (
                      <Button
                        size="sm"
                        disabled={pending}
                        onClick={() => {
                          setAuthorizationPending(true);
                          void startHostedProviderAuthorization(
                            connection.provider,
                            "/settings/providers",
                            undefined,
                            {
                              purpose: "user_identity",
                              connectionId: connection.connectionId,
                            },
                          ).catch((cause: unknown) => {
                            setAuthorizationPending(false);
                            toast.error(
                              cause instanceof Error
                                ? cause.message
                                : "Authorization failed",
                            );
                          });
                        }}
                      >
                        {authorizationPending && (
                          <Loader2 className="size-4 animate-spin" />
                        )}
                        Connect with {providerLabel(connection.provider)}
                      </Button>
                    )}
                  <Button
                    variant={canReconnect ? "secondary" : "primary"}
                    size="sm"
                    disabled={pending}
                    onClick={() => setPatConnectionId(connection.connectionId)}
                  >
                    {canReconnect
                      ? "Use a personal token"
                      : "Connect with a token"}
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {patConnectionId && (
        <PersonalTokenDialog
          connection={connections.find(
            (connection) => connection.connectionId === patConnectionId,
          )}
          localMode={localMode}
          onClose={() => setPatConnectionId(undefined)}
        />
      )}
    </section>
  );
}

/** Collects one personal PAT for the selected workspace connection. */
function PersonalTokenDialog({
  connection,
  localMode,
  onClose,
}: {
  connection:
    | {
        connectionId: string;
        provider: "github" | "gitlab" | "azure_devops";
        displayName: string;
      }
    | undefined;
  localMode: boolean;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const utils = api.useUtils();
  const [token, setToken] = useState("");
  const connect = api.provider.connectPersonalCredential.useMutation({
    onSuccess: async () => {
      await utils.provider.commentIdentity.invalidate();
      toast.success("Personal account connected");
      onClose();
    },
  });

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
    };
  }, []);

  if (!connection) return null;

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      className={cn(
        modalSurfaceClassName,
        "z-[70] items-center justify-center p-4 backdrop:bg-black/65 backdrop:backdrop-blur-sm",
      )}
      onCancel={(event) => {
        event.preventDefault();
        if (!connect.isPending) onClose();
      }}
    >
      <div className="bg-panel relative w-full max-w-lg overflow-hidden rounded-2xl border border-line-strong shadow-2xl shadow-black/30">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
          <div>
            <h2 id={titleId} className="text-cloud text-base font-semibold">
              Post as yourself on {providerLabel(connection.provider)}
            </h2>
            <p className="text-mist mt-1 text-xs leading-5">
              Paste a token for your own {providerLabel(connection.provider)}{" "}
              account. It is used only to publish, reply, and submit review
              decisions as you on {connection.displayName}.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={connect.isPending}
            onClick={onClose}
            className="text-fog hover:text-cloud grid size-9 shrink-0 place-items-center rounded-full transition hover:bg-white/[.04]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="grid gap-4 px-5 py-5">
          <label className="text-mist grid gap-2 text-xs">
            Personal access token
            <input
              type="password"
              autoComplete="off"
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
                connect.reset();
              }}
              placeholder="Paste the token value"
              className="bg-surface text-cloud focus:border-lime/40 h-11 rounded-xl border border-line px-4 font-mono text-sm outline-none"
            />
            <span className="text-fog text-[10px] leading-4">
              {localMode
                ? "Stored encrypted in your local data volume."
                : "Stored with workspace-bound AES-256-GCM encryption."}{" "}
              ReviewDuck never displays the token after connection.
            </span>
          </label>
          {connect.error && (
            <div
              role="alert"
              className="border-coral/30 bg-coral/[.065] text-cloud flex gap-3 rounded-xl border px-4 py-3"
            >
              <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
              <div>
                <p className="text-xs font-medium">Connection failed</p>
                <p className="text-mist mt-1 text-[11px] leading-5">
                  {connect.error.message}
                </p>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button
            variant="ghost"
            disabled={connect.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={!token || connect.isPending}
            onClick={() =>
              connect.mutate({
                connectionId: connection.connectionId,
                accessToken: token,
              })
            }
          >
            {connect.isPending && <Loader2 className="size-4 animate-spin" />}
            Verify & connect
          </Button>
        </div>
      </div>
    </dialog>
  );
}
