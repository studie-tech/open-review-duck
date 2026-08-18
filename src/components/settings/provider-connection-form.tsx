"use client";

import { Check, CircleAlert, Loader2, ShieldCheck, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type ProviderConnectionMethod,
  ProviderConnectionMethodPicker,
} from "~/components/settings/provider-connection-method";
import { ProviderTokenGuide } from "~/components/settings/provider-token-guide";
import { Button } from "~/components/ui/button";
import { modalSurfaceClassName } from "~/components/ui/modal-surface";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import { type Connection, type Provider, providers } from "./provider-common";

/** Distinguishes creating a connection from replacing an existing token. */
export type ConnectionFormMode =
  | { kind: "create"; provider?: Provider }
  | { kind: "replace"; connection: Connection };

/** Renders the modal that connects a provider or replaces a saved token. */
export function ConnectionFormDialog({
  authorizationPending,
  connections,
  localMode,
  mode,
  onAuthorize,
  onClose,
  onConnected,
}: {
  authorizationPending: boolean;
  connections: Connection[];
  localMode: boolean;
  mode: ConnectionFormMode;
  onAuthorize: (provider: Provider) => void;
  onClose: () => void;
  onConnected: (connection: Connection, replaced: boolean) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const editingConnection =
    mode.kind === "replace" ? mode.connection : undefined;
  const [provider, setProvider] = useState<Provider>(
    editingConnection?.provider ??
      (mode.kind === "create" ? (mode.provider ?? "github") : "github"),
  );
  const [connectionMethod, setConnectionMethod] =
    useState<ProviderConnectionMethod>(
      editingConnection || localMode || provider === "azure_devops"
        ? "pat"
        : "managed",
    );
  const [token, setToken] = useState("");
  const [account, setAccount] = useState(editingConnection?.displayName ?? "");
  const [baseUrl, setBaseUrl] = useState(editingConnection?.baseUrl ?? "");
  const connect = api.provider.connect.useMutation({
    onSuccess: (connection) => {
      if (connection) onConnected(connection, Boolean(editingConnection));
    },
    onError: (error) =>
      toast.error("Could not connect provider", {
        description: error.message,
      }),
  });
  const pending = connect.isPending || authorizationPending;

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement as HTMLElement | null;
    if (element && !element.open) {
      if (typeof element.showModal === "function") element.showModal();
      else element.setAttribute("open", "");
    }
    return () => {
      if (element?.open && typeof element.close === "function") element.close();
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    /** Dismisses the modal independently of which element currently has focus. */
    function dismissOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || pending) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }

    document.addEventListener("keydown", dismissOnEscape, true);
    return () => document.removeEventListener("keydown", dismissOnEscape, true);
  }, [onClose, pending]);

  const requiresConnectionLabel = connections.some(
    (connection) =>
      connection.provider === provider &&
      connection.id !== editingConnection?.id,
  );
  const usesTokenForm =
    Boolean(editingConnection) ||
    localMode ||
    provider === "azure_devops" ||
    connectionMethod === "pat";

  /** Switches the create form to another provider and clears provider input. */
  function selectProvider(nextProvider: Provider) {
    setProvider(nextProvider);
    // The token belongs to the provider it was created for; carrying it across
    // a switch would send that secret to a different provider's host.
    setToken("");
    setBaseUrl("");
    setConnectionMethod(
      localMode || nextProvider === "azure_devops" ? "pat" : "managed",
    );
    connect.reset();
  }

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
        if (!pending) onClose();
      }}
    >
      <div className="bg-panel relative flex max-h-[88dvh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-line-strong shadow-2xl shadow-black/30">
        <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div>
            <h2 id={titleId} className="text-cloud text-base font-semibold">
              {editingConnection
                ? `Replace token for ${editingConnection.displayName}`
                : "Add a provider connection"}
            </h2>
            <p className="text-mist mt-1 text-xs leading-5">
              {editingConnection
                ? "The saved token is never displayed. Paste a replacement below; repositories and review history will stay connected."
                : localMode
                  ? "Access tokens are encrypted before they are stored in your local data volume."
                  : "Use the provider's authorization flow, or connect with an encrypted access token when organization policy requires it."}
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={pending}
            onClick={onClose}
            className="text-fog hover:text-cloud grid size-9 shrink-0 place-items-center rounded-full transition hover:bg-white/[.04]"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-5 sm:px-6">
          {!editingConnection && (
            <div className="grid gap-3 sm:grid-cols-3">
              {providers.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => selectProvider(item.id)}
                  className={`rounded-2xl border p-4 text-left transition ${
                    provider === item.id
                      ? "border-lime/35 bg-lime/[.055]"
                      : "border-line bg-surface/70 hover:bg-surface-hover"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium">{item.label}</span>
                    {provider === item.id && (
                      <Check className="text-lime size-4" />
                    )}
                  </div>
                  <p className="text-mist mt-2 text-[11px] leading-5">
                    {localMode ? item.description : item.hostedDescription}
                  </p>
                </button>
              ))}
            </div>
          )}
          {!editingConnection && !localMode && provider !== "azure_devops" && (
            <ProviderConnectionMethodPicker
              provider={provider}
              method={connectionMethod}
              onChange={(method) => {
                setConnectionMethod(method);
                setBaseUrl("");
                if (method === "managed") setToken("");
                connect.reset();
              }}
            />
          )}
          {usesTokenForm ? (
            <div className="mt-6 grid gap-4">
              <ProviderTokenGuide
                key={provider}
                provider={provider}
                baseUrl={baseUrl}
              />
              {!localMode && (
                <div className="border-line bg-surface-subtle text-mist flex gap-3 rounded-xl border px-4 py-3 text-[11px] leading-5">
                  <ShieldCheck className="text-lime mt-0.5 size-4 shrink-0" />
                  <p>
                    The listed permissions cover source, comments, and review
                    decisions. ReviewDuck also tries to enable provider event
                    delivery; if your account cannot manage hooks, the
                    connection still works and you can fetch updates with
                    <span className="text-cloud"> Check now</span>.
                  </p>
                </div>
              )}
              <label className="text-mist grid gap-2 text-xs">
                {provider === "github"
                  ? "Fine-grained personal access token"
                  : provider === "azure_devops"
                    ? "Personal access token"
                    : "Access token"}
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
                    ? "Stored encrypted in your local data volume. ReviewDuck never displays the token after connection."
                    : "Stored with workspace-bound AES-256-GCM encryption. ReviewDuck never displays the token after connection."}
                </span>
              </label>
              <label className="text-mist grid gap-2 text-xs">
                {requiresConnectionLabel
                  ? "Connection label"
                  : "Connection label (optional)"}
                <input
                  value={account}
                  onChange={(event) => {
                    setAccount(event.target.value);
                    connect.reset();
                  }}
                  placeholder={`e.g. Work ${providers.find(({ id }) => id === provider)?.label}`}
                  className="bg-surface text-cloud focus:border-lime/40 h-11 rounded-xl border border-line px-4 text-sm outline-none"
                />
                {requiresConnectionLabel && (
                  <span className="text-fog text-[10px] leading-4">
                    Use the resource owner, such as “studie-tech”, to
                    distinguish this token.
                  </span>
                )}
              </label>
              {(localMode || provider === "azure_devops") && (
                <label className="text-mist grid gap-2 text-xs">
                  {provider === "azure_devops"
                    ? "Organization URL"
                    : `${provider === "github" ? "Enterprise" : "Custom"} API URL (optional)`}
                  <input
                    value={baseUrl}
                    onChange={(event) => {
                      setBaseUrl(event.target.value);
                      connect.reset();
                    }}
                    placeholder={
                      provider === "azure_devops"
                        ? "https://dev.azure.com/acme"
                        : provider === "github"
                          ? "https://github.example.com/api/v3"
                          : "https://gitlab.example.com/api/v4"
                    }
                    className="bg-surface text-cloud focus:border-lime/40 h-11 rounded-xl border border-line px-4 text-sm outline-none"
                  />
                  {!localMode && provider === "azure_devops" && (
                    <span className="text-fog text-[10px] leading-4">
                      Enter an organization this PAT can access. Add another
                      connection for each additional organization you want to
                      review.
                    </span>
                  )}
                </label>
              )}
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
          ) : (
            <p className="text-mist mt-6 text-sm leading-6">
              Authorization happens on the provider. ReviewDuck stores the
              resulting App or OAuth identity and never receives your password.
            </p>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4 sm:px-6">
          <Button variant="ghost" disabled={pending} onClick={onClose}>
            Cancel
          </Button>
          {usesTokenForm ? (
            <Button
              disabled={
                !token ||
                (provider === "azure_devops" && !baseUrl) ||
                (requiresConnectionLabel && !account.trim()) ||
                pending
              }
              onClick={() =>
                connect.mutate({
                  connectionId: editingConnection?.id,
                  provider,
                  displayName: account.trim() || undefined,
                  accessToken: token,
                  baseUrl: baseUrl || undefined,
                })
              }
            >
              {connect.isPending && <Loader2 className="size-4 animate-spin" />}
              {editingConnection ? "Verify & replace" : "Verify & connect"}
            </Button>
          ) : (
            <Button disabled={pending} onClick={() => onAuthorize(provider)}>
              {authorizationPending && (
                <Loader2 className="size-4 animate-spin" />
              )}
              Authorize with{" "}
              {providers.find(({ id }) => id === provider)?.label}
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
