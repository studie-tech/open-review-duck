"use client";

import {
  Check,
  ChevronDown,
  CircleAlert,
  Loader2,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { modalSurfaceClassName } from "~/components/ui/modal-surface";
import { startHostedProviderAuthorization } from "~/lib/hosted-provider-authorization";
import { supportsManagedReauthorization } from "~/lib/provider-credential-recovery";
import { providerLabel } from "~/lib/provider-labels";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

/** Integrates the reviewer’s posting preference into the selected connection. */
export function CommentIdentity({
  localMode,
  connectionId,
}: {
  localMode: boolean;
  connectionId: string;
}) {
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
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const optionsId = useId();
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [patConnectionId, setPatConnectionId] = useState<string>();

  if (!identity.data || identity.data.connections.length === 0) {
    return null;
  }

  const { publishAsSelf, connections } = identity.data;
  const connection = connections.find(
    (item) => item.connectionId === connectionId,
  );
  if (!connection) return null;
  const missingOthers = connections.filter(
    (item) => item.connectionId !== connectionId && !item.identity,
  ).length;
  const pending =
    authorizationPending || disconnect.isPending || save.isPending;
  const canReconnect = supportsManagedReauthorization(
    localMode,
    connection.credentialKind,
    connection.provider,
  );
  const hostedProvider =
    connection.provider === "github" || connection.provider === "gitlab"
      ? connection.provider
      : undefined;
  const connected = connection.identity;
  const needsAccount = publishAsSelf && !connected;

  return (
    <section
      aria-labelledby={headingId}
      className="overflow-hidden rounded-2xl border border-line bg-surface/70"
    >
      <div className="flex items-center gap-3 px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl border border-line bg-surface-subtle text-mist">
          {publishAsSelf ? (
            <UserRound className="size-4" />
          ) : (
            <UsersRound className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 id={headingId} className="text-sm font-medium text-cloud">
              Posting identity
            </h3>
            <span
              className={cn(
                "rounded-md px-1.5 py-0.5 text-[10px]",
                needsAccount
                  ? "bg-coral/10 text-coral"
                  : "bg-surface-subtle text-mist",
              )}
            >
              {needsAccount
                ? "Account needed"
                : publishAsSelf
                  ? connected?.displayLogin
                  : "Shared connection"}
            </span>
          </div>
          <p className="mt-0.5 text-xs leading-5 text-mist">
            {needsAccount
              ? `Connect your ${providerLabel(connection.provider)} account to resume posting.`
              : publishAsSelf
                ? "Comments, replies, and review decisions are posted as you."
                : "Comments, replies, and review decisions use the workspace connection."}
          </p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={expanded}
          aria-controls={optionsId}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "Done" : needsAccount ? "Set up" : "Change"}
          <ChevronDown
            className={cn("size-3.5 transition", expanded && "rotate-180")}
          />
        </Button>
      </div>
      {expanded && (
        <div id={optionsId} className="border-t border-line px-4 py-4">
          <fieldset>
            <legend className="text-xs font-medium text-cloud">
              Who should your posts appear as?
            </legend>
            <p className="mt-1 text-[11px] leading-5 text-fog">
              Your preference applies to all connections in this workspace.
              Other members keep their own preference.
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {[
                {
                  value: false,
                  label: "Shared connection",
                  description: "Use the workspace’s connected account.",
                  Icon: UsersRound,
                },
                {
                  value: true,
                  label: "My account",
                  description: "Use your own provider identity.",
                  Icon: UserRound,
                },
              ].map(({ value, label, description, Icon }) => (
                <label
                  key={label}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-3 transition has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-lime/55",
                    publishAsSelf === value
                      ? "border-lime/35 bg-lime/[.045]"
                      : "border-line hover:bg-surface-subtle",
                    pending && "cursor-wait opacity-60",
                  )}
                >
                  <input
                    type="radio"
                    name={headingId}
                    value={String(value)}
                    checked={publishAsSelf === value}
                    disabled={pending}
                    onChange={() => save.mutate({ publishAsSelf: value })}
                    className="sr-only"
                  />
                  <Icon className="mt-0.5 size-4 shrink-0 text-mist" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-cloud">
                      {label}
                    </span>
                    <span className="mt-1 block text-[11px] leading-4 text-mist">
                      {description}
                    </span>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border",
                      publishAsSelf === value
                        ? "border-lime bg-lime text-accent-foreground"
                        : "border-line-strong",
                    )}
                  >
                    {publishAsSelf === value && <Check className="size-3" />}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          {(publishAsSelf || connected) && (
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-4">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-cloud">
                  {connected
                    ? `Connected as ${connected.displayLogin}`
                    : `Your ${providerLabel(connection.provider)} account`}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-mist">
                  {connected
                    ? `Personal identity for ${connection.displayName}.`
                    : "Posting here is paused until you connect your account."}
                </p>
              </div>
              {connected ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => disconnect.mutate({ connectionId })}
                >
                  Disconnect personal account
                </Button>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  {canReconnect && hostedProvider && (
                    <Button
                      size="sm"
                      disabled={pending}
                      onClick={() => {
                        setAuthorizationPending(true);
                        void startHostedProviderAuthorization(
                          hostedProvider,
                          "/settings/providers",
                          undefined,
                          { purpose: "user_identity", connectionId },
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
                        <Loader2 className="size-3.5 animate-spin" />
                      )}
                      Connect my {providerLabel(connection.provider)} account
                    </Button>
                  )}
                  <Button
                    variant={canReconnect ? "ghost" : "secondary"}
                    size="sm"
                    disabled={pending}
                    onClick={() => setPatConnectionId(connectionId)}
                  >
                    {canReconnect
                      ? "Use a token instead"
                      : "Connect my account"}
                  </Button>
                </div>
              )}
            </div>
          )}
          {publishAsSelf && missingOthers > 0 && (
            <p className="mt-3 flex items-start gap-2 text-[11px] leading-5 text-fog">
              <CircleAlert className="mt-1 size-3 shrink-0" />
              {missingOthers} other{" "}
              {missingOthers === 1
                ? "connection also needs"
                : "connections also need"}{" "}
              your account before posting. Select{" "}
              {missingOthers === 1 ? "it" : "them"} in the sidebar to finish
              setup.
            </p>
          )}
        </div>
      )}

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
