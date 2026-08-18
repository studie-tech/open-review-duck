"use client";

import {
  Check,
  CircleAlert,
  GitPullRequest,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";
import {
  type Connection,
  credentialLabel,
  type ImportedRepository,
  providerLabel,
} from "./provider-common";

/** Renders the console detail pane for one provider connection. */
export function ConnectionDetail({
  authorizationPending,
  canReauthorize,
  canReplaceToken,
  connection,
  importedRepositories,
  localMode,
  onAddConnection,
  onDisconnect,
  onImported,
  onReauthorize,
  onReplaceToken,
  onSelectRepository,
}: {
  authorizationPending: boolean;
  canReauthorize: boolean;
  canReplaceToken: boolean;
  connection: Connection;
  importedRepositories: ImportedRepository[];
  localMode: boolean;
  onAddConnection: () => void;
  onDisconnect: () => void;
  onImported: (repository: ImportedRepository) => void;
  onReauthorize: () => void;
  onReplaceToken: () => void;
  onSelectRepository: (repositoryId: string) => void;
}) {
  const [repositorySearch, setRepositorySearch] = useState("");
  const availableRepositories = api.provider.listAvailableRepositories.useQuery(
    { connectionId: connection.id },
    {
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const importRepository = api.provider.importRepository.useMutation({
    onSuccess: (repository) => {
      if (!repository) return;
      onImported({
        id: repository.id,
        externalId: repository.externalId,
        owner: repository.owner,
        name: repository.name,
        provider: connection.provider,
        connectionName: connection.displayName,
        credentialKind: connection.credentialKind,
        connectionId: repository.connectionId,
        webUrl: repository.webUrl,
        reviewIntakeMode: repository.reviewIntakeMode,
        intakeLastAttemptAt: repository.intakeLastAttemptAt,
        intakeLastReconciledAt: repository.intakeLastReconciledAt,
        intakeLastError: repository.intakeLastError,
      });
    },
    onError: (error) => toast.error(error.message),
  });

  /** Derives a truthful connection state from the latest provider request. */
  function connectionStatus() {
    if (connection.credentialStatus !== "active") {
      return {
        label:
          connection.credentialStatus === "suspended"
            ? "Suspended"
            : "Reconnect required",
        tone: "text-coral",
        dot: "bg-coral",
      };
    }
    if (availableRepositories.isFetching) {
      return { label: "Checking", tone: "text-cyan", dot: "bg-cyan" };
    }
    if (availableRepositories.isError) {
      const limited = availableRepositories.error.message
        .toLowerCase()
        .includes("rate limit");
      return {
        label: limited ? "Rate limited" : "Needs attention",
        tone: "text-coral",
        dot: "bg-coral",
      };
    }
    if (availableRepositories.data) {
      return { label: "Ready", tone: "text-lime", dot: "bg-lime" };
    }
    return { label: "Saved", tone: "text-mist", dot: "bg-fog" };
  }

  const status = connectionStatus();
  const connectionError =
    connection.credentialStatus !== "active"
      ? `${connection.displayName}'s authorization is ${connection.credentialStatus}. Reconnect it to restore access.`
      : availableRepositories.isError
        ? availableRepositories.error.message
        : undefined;
  const normalizedRepositorySearch = repositorySearch.trim().toLowerCase();
  const filteredRepositories = availableRepositories.data?.filter(
    (repository) =>
      `${repository.owner}/${repository.name}`
        .toLowerCase()
        .includes(normalizedRepositorySearch),
  );

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-fog flex flex-wrap items-center gap-2 text-xs">
            {providerLabel(connection.provider)}
            <span className="border-line bg-surface-subtle text-fog rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase">
              {credentialLabel(connection.credentialKind)}
            </span>
            <span className={cn("flex items-center gap-1.5", status.tone)}>
              <span className={cn("size-1.5 rounded-full", status.dot)} />
              {status.label}
            </span>
          </p>
          <h2 className="mt-2 truncate text-2xl font-medium tracking-[-.02em]">
            {connection.displayName}
          </h2>
          <p className="text-mist mt-1 text-xs">
            {importedRepositories.length === 0
              ? "No repositories from this connection yet."
              : `${importedRepositories.length} ${
                  importedRepositories.length === 1
                    ? "repository"
                    : "repositories"
                } in this workspace.`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          {canReauthorize && (
            <Button
              size="sm"
              variant="secondary"
              disabled={authorizationPending}
              onClick={onReauthorize}
            >
              {authorizationPending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Reconnect
            </Button>
          )}
          {canReplaceToken && (
            <Button size="sm" variant="secondary" onClick={onReplaceToken}>
              <Pencil className="size-3.5" /> Replace token
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={onDisconnect}
            className="hover:bg-red-400/10 hover:text-red-700 dark:hover:text-red-200"
          >
            <Trash2 className="size-3.5" /> Disconnect
          </Button>
        </div>
      </div>

      {connectionError && (
        <div
          role="alert"
          className="border-coral/25 bg-coral/[.055] flex flex-col gap-3 rounded-2xl border px-4 py-3 sm:flex-row sm:items-center"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-cloud text-xs font-medium">
                Connection check failed
              </p>
              <p className="text-mist mt-1 text-[11px] leading-5">
                {connectionError}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={availableRepositories.isFetching}
            onClick={() => void availableRepositories.refetch()}
          >
            <RefreshCw
              className={cn(
                "size-3.5",
                availableRepositories.isFetching && "animate-spin",
              )}
            />
            Retry
          </Button>
        </div>
      )}

      <section className="bg-surface/70 rounded-2xl border border-line">
        <div className="flex flex-col gap-3 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h3 className="text-sm font-medium">Add repositories</h3>
            <p className="text-mist mt-0.5 text-xs">
              Add only repositories that should be available in this workspace.
              {availableRepositories.data &&
                ` ${availableRepositories.data.length} available from this connection.`}
            </p>
          </div>
          <input
            type="search"
            value={repositorySearch}
            onChange={(event) => setRepositorySearch(event.target.value)}
            placeholder="Filter repositories"
            aria-label="Filter repositories"
            className="bg-surface text-cloud focus:border-lime/40 h-9 w-full rounded-lg border border-line px-3 text-xs outline-none sm:w-56"
          />
        </div>
        <div className="p-3">
          {localMode && connection.provider === "github" && (
            <div className="border-cyan/15 bg-cyan/[.025] text-mist mb-2 flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-[10px] leading-4 sm:flex-row sm:items-center sm:justify-between">
              <p>
                Fine-grained tokens expose private repositories for one resource
                owner. Add another connection for each additional user or
                organization.
              </p>
              <button
                type="button"
                onClick={onAddConnection}
                className="text-cyan hover:text-cloud shrink-0 text-left font-medium transition"
              >
                Add GitHub token
              </button>
            </div>
          )}
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {availableRepositories.isLoading && (
              <Loader2 className="text-lime m-4 size-4 animate-spin" />
            )}
            {filteredRepositories?.map((repository) => {
              const imported = importedRepositories.find(
                (item) => item.externalId === repository.externalId,
              );
              return (
                <div
                  key={repository.externalId}
                  className="bg-surface-subtle flex items-center gap-3 rounded-xl border border-line px-4 py-2.5"
                >
                  <GitPullRequest className="text-fog size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate text-sm">
                    {repository.owner}/{repository.name}
                  </span>
                  {imported ? (
                    <button
                      type="button"
                      onClick={() => onSelectRepository(imported.id)}
                      className="text-lime hover:text-cloud flex items-center gap-1.5 text-xs transition"
                    >
                      <Check className="size-3.5" /> Added
                    </button>
                  ) : (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={importRepository.isPending}
                      onClick={() =>
                        importRepository.mutate({
                          connectionId: connection.id,
                          externalId: repository.externalId,
                        })
                      }
                    >
                      {importRepository.isPending &&
                        importRepository.variables?.externalId ===
                          repository.externalId && (
                          <Loader2 className="size-3.5 animate-spin" />
                        )}
                      Add
                    </Button>
                  )}
                </div>
              );
            })}
            {!availableRepositories.isLoading &&
              !availableRepositories.isError &&
              filteredRepositories?.length === 0 && (
                <div className="border-line bg-surface-subtle text-mist rounded-xl border px-4 py-5 text-center text-xs">
                  {normalizedRepositorySearch
                    ? "No repository allowed by this token matches your search."
                    : "This token does not currently expose any repositories."}
                </div>
              )}
          </div>
        </div>
      </section>
    </div>
  );
}
