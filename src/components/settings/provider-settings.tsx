"use client";

import {
  Check,
  CircleAlert,
  GitPullRequest,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import {
  type CodeProvider,
  ProviderTokenGuide,
} from "~/components/settings/provider-token-guide";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import { api, type RouterOutputs } from "~/trpc/react";

type Connection = RouterOutputs["provider"]["listConnections"][number];
type ImportedRepository =
  RouterOutputs["provider"]["listImportedRepositories"][number];
type Provider = CodeProvider;

const providers: Array<{
  id: Provider;
  label: string;
  description: string;
}> = [
  {
    id: "github",
    label: "GitHub",
    description: "Fine-grained token · code read + PR comments",
  },
  {
    id: "gitlab",
    label: "GitLab",
    description: "api scope · personal, project, or group token",
  },
  {
    id: "azure_devops",
    label: "Azure DevOps",
    description: "PAT · Code (Read & write) permission",
  },
];

/** Renders the provider settings interface. */
export function ProviderSettings({
  initialConnections,
  initialRepositories,
  localMode,
}: {
  initialConnections: Connection[];
  initialRepositories: ImportedRepository[];
  localMode: boolean;
}) {
  const router = useRouter();
  const utils = api.useUtils();
  const [connections, setConnections] = useState(initialConnections);
  const [repositories, setRepositories] = useState(initialRepositories);
  const [provider, setProvider] = useState<Provider>("github");
  const [showForm, setShowForm] = useState(initialConnections.length === 0);
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [repositorySearch, setRepositorySearch] = useState("");
  const [connectionToDisconnect, setConnectionToDisconnect] =
    useState<Connection>();
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    initialConnections[0]?.id ?? "",
  );
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(
    initialRepositories[0]?.id ?? "",
  );
  const availableRepositories = api.provider.listAvailableRepositories.useQuery(
    { connectionId: selectedConnectionId },
    { enabled: Boolean(selectedConnectionId), staleTime: 60_000 },
  );
  const openPullRequests = api.provider.listOpenPullRequests.useQuery(
    { repositoryId: selectedRepositoryId },
    { enabled: Boolean(selectedRepositoryId), staleTime: 30_000 },
  );
  const connect = api.provider.connect.useMutation({
    onSuccess: (connection) => {
      if (connection) {
        setConnections((current) => [
          ...current.filter(({ id }) => id !== connection.id),
          { ...connection, baseUrl: baseUrl || null, createdAt: new Date() },
        ]);
        setSelectedConnectionId(connection.id);
      }
      setToken("");
      setAccount("");
      setShowForm(false);
      void utils.workspace.guidance.invalidate();
      toast.success("Provider connected");
    },
    onError: (error) =>
      toast.error("Could not connect provider", {
        description: error.message,
      }),
  });
  const importRepository = api.provider.importRepository.useMutation({
    onSuccess: (repository) => {
      if (!repository) return;
      setRepositories((current) => [
        ...current.filter(({ id }) => id !== repository.id),
        {
          id: repository.id,
          externalId: repository.externalId,
          owner: repository.owner,
          name: repository.name,
          provider:
            connections.find(({ id }) => id === repository.connectionId)
              ?.provider ?? "github",
          connectionId: repository.connectionId,
        },
      ]);
      setSelectedRepositoryId(repository.id);
      toast.success("Repository added");
    },
    onError: (error) => toast.error(error.message),
  });
  const disconnect = api.provider.disconnect.useMutation({
    onSuccess: ({ id }) => {
      setConnectionToDisconnect(undefined);
      const remainingConnections = connections.filter(
        (connection) => connection.id !== id,
      );
      setConnections(remainingConnections);
      setRepositories((current) =>
        current.filter((repository) => repository.connectionId !== id),
      );
      setSelectedConnectionId(remainingConnections[0]?.id ?? "");
      setSelectedRepositoryId((current) =>
        repositories.some(
          (repository) =>
            repository.id === current && repository.connectionId !== id,
        )
          ? current
          : "",
      );
      void utils.workspace.guidance.invalidate();
      toast.success("Provider disconnected");
    },
    onError: (error) => toast.error(error.message),
  });
  const syncPullRequest = api.review.sync.useMutation({
    onSuccess: (result) => {
      const skippedFiles = result.unsupportedFiles.length;
      toast.success("Review path prepared", {
        description: `${result.unitCount} review units · ${result.changedUnitCount} changed or new${
          skippedFiles > 0 ? ` · ${skippedFiles} too large to load` : ""
        }`,
      });
      router.push(`/review/${result.pullRequest.id}`);
      router.refresh();
    },
    onError: (error) =>
      toast.error("Could not prepare review", {
        description: error.message,
      }),
  });
  const selectedConnection = connections.find(
    ({ id }) => id === selectedConnectionId,
  );
  const requiresConnectionLabel = connections.some(
    (connection) => connection.provider === provider,
  );
  const normalizedRepositorySearch = repositorySearch.trim().toLowerCase();
  const filteredRepositories = availableRepositories.data?.filter(
    (repository) =>
      `${repository.owner}/${repository.name}`
        .toLowerCase()
        .includes(normalizedRepositorySearch),
  );

  /** Opens and resets the GitHub connection form for a new token. */
  const showGitHubConnectionForm = () => {
    setProvider("github");
    setToken("");
    setAccount("");
    setBaseUrl("");
    connect.reset();
    setShowForm(true);
    requestAnimationFrame(() =>
      document
        .getElementById("provider-connection-form")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  return (
    <PageContainer>
      <div className="flex flex-col items-stretch gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
            Integrations
          </p>
          <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
            Code providers
          </h1>
          <p className="text-mist mt-2 text-sm">
            {localMode
              ? "Access tokens are encrypted before they are stored in your local data volume."
              : "Access tokens are encrypted before they are stored in Postgres."}
          </p>
        </div>
        {connections.length > 0 && (
          <Button
            variant="secondary"
            onClick={() => setShowForm((value) => !value)}
            className="w-full sm:w-auto"
          >
            {showForm ? (
              <>
                <X className="size-4" /> Cancel
              </>
            ) : (
              <>
                <Plus className="size-4" /> Add connection
              </>
            )}
          </Button>
        )}
      </div>

      {showForm && (
        <section
          id="provider-connection-form"
          className="bg-surface mt-8 scroll-mt-6 rounded-3xl border border-line p-5 sm:p-7"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {providers.map((item) => (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  setProvider(item.id);
                  setBaseUrl("");
                  connect.reset();
                }}
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
                  {item.description}
                </p>
              </button>
            ))}
          </div>
          <div className="mt-6 grid gap-4">
            <ProviderTokenGuide
              key={provider}
              provider={provider}
              baseUrl={baseUrl}
            />
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
                Stored encrypted. ReviewDuck never displays the token after
                connection.
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
                placeholder="e.g. Work GitHub"
                className="bg-surface text-cloud focus:border-lime/40 h-11 rounded-xl border border-line px-4 text-sm outline-none"
              />
              {requiresConnectionLabel && (
                <span className="text-fog text-[10px] leading-4">
                  Use the resource owner, such as “studie-tech”, to distinguish
                  this token.
                </span>
              )}
            </label>
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
            <div className="flex justify-end">
              <Button
                disabled={
                  !token ||
                  (requiresConnectionLabel && !account.trim()) ||
                  connect.isPending
                }
                onClick={() =>
                  connect.mutate({
                    provider,
                    displayName: account || undefined,
                    accessToken: token,
                    baseUrl: baseUrl || undefined,
                  })
                }
              >
                {connect.isPending && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                Verify & connect
              </Button>
            </div>
          </div>
        </section>
      )}

      <section className="mt-8 space-y-3">
        {connections.map((connection) => (
          <div
            key={connection.id}
            className="bg-surface/70 flex items-center gap-4 rounded-2xl border border-line p-5"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-surface-subtle">
              <GitPullRequest className="text-mist size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {connection.displayName}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
                <p className="text-fog text-xs capitalize">
                  {connection.provider.replace("_", " ")}
                </p>
                <span className="text-lime flex items-center gap-1.5 text-xs sm:hidden">
                  <span className="bg-lime size-1.5 rounded-full" /> Connected
                </span>
              </div>
            </div>
            <span className="text-lime hidden shrink-0 items-center gap-1.5 text-xs sm:flex">
              <span className="bg-lime size-1.5 rounded-full" /> Connected
            </span>
            <button
              type="button"
              aria-label={`Disconnect ${connection.displayName}`}
              disabled={disconnect.isPending}
              onClick={() => setConnectionToDisconnect(connection)}
              className="text-fog grid size-9 shrink-0 place-items-center rounded-full transition hover:bg-red-400/10 hover:text-red-700 dark:hover:text-red-200"
            >
              <Trash2 className="size-3.5" />
            </button>
          </div>
        ))}
      </section>

      {connectionToDisconnect && (
        <ConfirmationDialog
          title={`Disconnect ${connectionToDisconnect.displayName}?`}
          description={
            <>
              Imported repositories and their review history will be removed.
              The provider access token will also be deleted.
            </>
          }
          confirmLabel="Disconnect"
          confirmVariant="danger"
          pendingLabel={
            <>
              <Loader2 className="size-4 animate-spin" />
              Disconnecting…
            </>
          }
          pending={disconnect.isPending}
          icon={<Trash2 className="size-4 text-red-500 dark:text-red-300" />}
          iconClassName="bg-red-400/10"
          onCancel={() => setConnectionToDisconnect(undefined)}
          onConfirm={() =>
            disconnect.mutate({
              connectionId: connectionToDisconnect.id,
            })
          }
        />
      )}

      {connections.length > 0 && (
        <section className="mt-12">
          <div>
            <p className="text-lime text-xs font-semibold tracking-[.16em] uppercase">
              Repositories
            </p>
            <h2 className="mt-2 text-xl font-medium">Choose what to review</h2>
          </div>
          <div className="bg-surface/70 mt-5 grid gap-5 rounded-3xl border border-line p-5 sm:p-6">
            <label className="text-mist grid gap-2 text-xs">
              Provider connection
              <select
                value={selectedConnectionId}
                onChange={(event) =>
                  setSelectedConnectionId(event.target.value)
                }
                className="bg-surface text-cloud h-11 rounded-xl border border-line px-4 text-sm outline-none"
              >
                {connections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.displayName}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2">
              <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <p className="text-mist flex items-center gap-2 text-xs">
                  Available repositories
                  {availableRepositories.data && (
                    <span className="border-line bg-surface-subtle text-fog rounded-full border px-2 py-0.5 text-[10px]">
                      {availableRepositories.data.length} from this token
                    </span>
                  )}
                </p>
                <input
                  type="search"
                  value={repositorySearch}
                  onChange={(event) => setRepositorySearch(event.target.value)}
                  placeholder="Filter repositories"
                  aria-label="Filter repositories"
                  className="bg-surface text-cloud focus:border-lime/40 h-9 w-full rounded-lg border border-line px-3 text-xs outline-none sm:w-56"
                />
              </div>
              {selectedConnection?.provider === "github" && (
                <div className="border-cyan/15 bg-cyan/[.025] text-mist flex flex-col gap-2 rounded-xl border px-3 py-2.5 text-[10px] leading-4 sm:flex-row sm:items-center sm:justify-between">
                  <p>
                    Fine-grained tokens expose private repositories for one
                    resource owner. Add another connection for each additional
                    user or organization.
                  </p>
                  <button
                    type="button"
                    onClick={showGitHubConnectionForm}
                    className="text-cyan hover:text-cloud shrink-0 font-medium transition"
                  >
                    Add GitHub token
                  </button>
                </div>
              )}
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {availableRepositories.isLoading && (
                  <Loader2 className="text-lime m-4 size-4 animate-spin" />
                )}
                {availableRepositories.isError && (
                  <div className="border-coral/25 bg-coral/[.055] text-mist rounded-xl border px-4 py-3 text-xs">
                    Could not load repositories. Check this connection and try
                    again.
                  </div>
                )}
                {filteredRepositories?.map((repository) => {
                  const imported = repositories.some(
                    (item) =>
                      item.connectionId === selectedConnectionId &&
                      item.externalId === repository.externalId,
                  );
                  return (
                    <div
                      key={repository.externalId}
                      className="bg-surface-subtle flex items-center gap-3 rounded-xl border border-line px-4 py-3"
                    >
                      <GitPullRequest className="text-fog size-4" />
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {repository.owner}/{repository.name}
                      </span>
                      {imported ? (
                        <span className="text-lime text-xs">Added</span>
                      ) : (
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() =>
                            importRepository.mutate({
                              connectionId: selectedConnectionId,
                              externalId: repository.externalId,
                            })
                          }
                        >
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
          </div>
        </section>
      )}

      {repositories.length > 0 && (
        <section className="mt-12 pb-16">
          <div className="flex items-end justify-between">
            <div>
              <p className="text-cyan text-xs font-semibold tracking-[.16em] uppercase">
                Pull requests
              </p>
              <h2 className="mt-2 text-xl font-medium">
                Prepare a dependency path
              </h2>
            </div>
            <button
              type="button"
              aria-label="Refresh pull requests"
              onClick={() => void openPullRequests.refetch()}
              className="text-mist hover:text-cloud"
            >
              <RefreshCw
                className={`size-4 ${openPullRequests.isFetching ? "animate-spin" : ""}`}
              />
            </button>
          </div>
          <div className="mt-5">
            <select
              value={selectedRepositoryId}
              onChange={(event) => setSelectedRepositoryId(event.target.value)}
              className="bg-surface text-cloud h-11 min-w-0 flex-1 rounded-xl border border-line px-4 text-sm outline-none"
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.owner}/{repository.name}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-4 space-y-2">
            {openPullRequests.isLoading && (
              <div className="grid h-24 place-items-center">
                <Loader2 className="text-cyan size-4 animate-spin" />
              </div>
            )}
            {openPullRequests.data?.map((pullRequest) => (
              <div
                key={pullRequest.externalId}
                className="bg-surface/70 flex flex-col gap-4 rounded-2xl border border-line p-5 sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    #{pullRequest.number} {pullRequest.title}
                  </p>
                  <p className="text-fog mt-1 text-xs">
                    {pullRequest.sourceBranch} → {pullRequest.targetBranch}
                  </p>
                </div>
                <Button
                  size="sm"
                  disabled={syncPullRequest.isPending}
                  onClick={() =>
                    syncPullRequest.mutate({
                      repositoryId: selectedRepositoryId,
                      number: pullRequest.number,
                    })
                  }
                >
                  {syncPullRequest.isPending && (
                    <Loader2 className="size-3.5 animate-spin" />
                  )}
                  Prepare review
                </Button>
              </div>
            ))}
            {openPullRequests.data?.length === 0 && (
              <p className="text-mist rounded-2xl border border-dashed border-line p-8 text-center text-sm">
                No open pull requests in this repository.
              </p>
            )}
          </div>
        </section>
      )}
    </PageContainer>
  );
}
