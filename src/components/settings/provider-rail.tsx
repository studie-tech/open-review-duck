"use client";

import { CircleAlert, Plus, Search } from "lucide-react";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";
import {
  type Connection,
  credentialLabel,
  type ImportedRepository,
  intakeModeMeta,
  providerLabel,
  type SettingsSelection,
} from "./provider-common";

/** Returns whether the connection or one of its repositories matches a search. */
function connectionMatches(
  connection: Connection,
  repositories: ImportedRepository[],
  search: string,
) {
  if (!search) return true;
  return (
    connection.displayName.toLowerCase().includes(search) ||
    providerLabel(connection.provider).toLowerCase().includes(search) ||
    repositories.some((repository) =>
      `${repository.owner}/${repository.name}`.toLowerCase().includes(search),
    )
  );
}

/** Renders the console rail listing connections with their repositories. */
export function ProviderRail({
  className,
  connections,
  onAddConnection,
  onSearchChange,
  onSelect,
  repositories,
  search,
  selection,
}: {
  className?: string;
  connections: Connection[];
  onAddConnection: () => void;
  onSearchChange: (search: string) => void;
  onSelect: (selection: SettingsSelection) => void;
  repositories: ImportedRepository[];
  search: string;
  selection?: SettingsSelection;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const repositoriesByConnection = new Map<string, ImportedRepository[]>();
  for (const repository of repositories) {
    if (!repository.connectionId) continue;
    const bucket = repositoriesByConnection.get(repository.connectionId);
    if (bucket) bucket.push(repository);
    else repositoriesByConnection.set(repository.connectionId, [repository]);
  }
  const visibleConnections = connections.filter((connection) =>
    connectionMatches(
      connection,
      repositoriesByConnection.get(connection.id) ?? [],
      normalizedSearch,
    ),
  );
  return (
    <nav
      aria-label="Provider connections and repositories"
      className={cn("flex min-h-0 flex-col gap-3", className)}
    >
      <label className="bg-surface focus-within:border-lime/40 flex h-10 items-center gap-2.5 rounded-xl border border-line px-3.5">
        <Search className="text-fog size-3.5 shrink-0" aria-hidden="true" />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Find a connection or repository"
          aria-label="Find a connection or repository"
          className="text-cloud placeholder:text-fog w-full bg-transparent text-xs outline-none"
        />
      </label>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-1 lg:pr-1">
        {visibleConnections.map((connection) => {
          const connectionRepositories =
            repositoriesByConnection.get(connection.id) ?? [];
          const connectionSelected =
            selection?.kind === "connection" && selection.id === connection.id;
          const connectionSearchMatch =
            !normalizedSearch ||
            connection.displayName.toLowerCase().includes(normalizedSearch) ||
            providerLabel(connection.provider)
              .toLowerCase()
              .includes(normalizedSearch);
          const visibleRepositories = connectionSearchMatch
            ? connectionRepositories
            : connectionRepositories.filter((repository) =>
                `${repository.owner}/${repository.name}`
                  .toLowerCase()
                  .includes(normalizedSearch),
              );
          const broken = connection.credentialStatus !== "active";
          return (
            <div key={connection.id}>
              <button
                type="button"
                onClick={() =>
                  onSelect({ kind: "connection", id: connection.id })
                }
                aria-current={connectionSelected ? "true" : undefined}
                className={cn(
                  "bg-surface/70 flex w-full items-center gap-3 rounded-xl border p-3 text-left transition",
                  connectionSelected
                    ? "border-lime/35 bg-lime/[.05]"
                    : "border-line hover:border-line-strong hover:bg-surface-hover",
                )}
              >
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    broken ? "bg-coral" : "bg-lime",
                  )}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {connection.displayName}
                  </span>
                  <span className="text-fog mt-0.5 block truncate text-[11px]">
                    {providerLabel(connection.provider)} ·{" "}
                    {credentialLabel(connection.credentialKind)}
                    {broken && <span className="text-coral"> · Reconnect</span>}
                  </span>
                </span>
                <span className="text-fog shrink-0 text-[11px] tabular-nums">
                  {connectionRepositories.length}
                </span>
              </button>
              <div className="mt-1 ml-3.5 border-l border-line pl-2.5">
                {visibleRepositories.map((repository) => {
                  const repositorySelected =
                    selection?.kind === "repository" &&
                    selection.id === repository.id;
                  const intake = intakeModeMeta[repository.reviewIntakeMode];
                  return (
                    <button
                      key={repository.id}
                      type="button"
                      onClick={() =>
                        onSelect({ kind: "repository", id: repository.id })
                      }
                      aria-current={repositorySelected ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition",
                        repositorySelected
                          ? "bg-surface-hover text-cloud"
                          : "text-mist hover:bg-surface-subtle hover:text-cloud",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-xs">
                        {repository.owner}/{repository.name}
                      </span>
                      {repository.intakeLastError && (
                        <CircleAlert
                          role="img"
                          className="text-coral size-3 shrink-0"
                          aria-label="Intake needs attention"
                        />
                      )}
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium",
                          intake.badgeClassName,
                        )}
                      >
                        {intake.label}
                      </span>
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() =>
                    onSelect({ kind: "connection", id: connection.id })
                  }
                  className="text-fog hover:text-cloud flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition"
                >
                  <Plus className="size-3 shrink-0" aria-hidden="true" />
                  Add repositories
                </button>
              </div>
            </div>
          );
        })}
        {connections.length > 0 && visibleConnections.length === 0 && (
          <p className="text-mist rounded-xl border border-dashed border-line px-3 py-6 text-center text-xs">
            Nothing matches “{search.trim()}”.
          </p>
        )}
      </div>
      <Button
        variant="secondary"
        size="sm"
        onClick={onAddConnection}
        className="w-full shrink-0"
      >
        <Plus className="size-4" /> Add connection
      </Button>
    </nav>
  );
}
