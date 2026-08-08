"use client";

import {
  Check,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitPullRequest,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
  WandSparkles,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import {
  type ProviderConnectionMethod,
  ProviderConnectionMethodPicker,
} from "~/components/settings/provider-connection-method";
import {
  type CodeProvider,
  ProviderTokenGuide,
} from "~/components/settings/provider-token-guide";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  supportsManagedReauthorization,
  supportsTokenReplacement,
} from "~/lib/provider-credential-recovery";
import { api, type RouterOutputs } from "~/trpc/react";

type Connection = RouterOutputs["provider"]["listConnections"][number];
type ImportedRepository =
  RouterOutputs["provider"]["listImportedRepositories"][number];
type Provider = CodeProvider;
type IntakeMode = ImportedRepository["reviewIntakeMode"];

const providers: Array<{
  id: Provider;
  label: string;
  description: string;
  hostedDescription: string;
}> = [
  {
    id: "github",
    label: "GitHub",
    description: "Fine-grained token · code read + PR comments",
    hostedDescription: "GitHub App or fine-grained token",
  },
  {
    id: "gitlab",
    label: "GitLab",
    description: "api scope · personal, project, or group token",
    hostedDescription: "OAuth or personal, project, or group token",
  },
  {
    id: "azure_devops",
    label: "Azure DevOps",
    description: "PAT · Code (Read & write) permission",
    hostedDescription: "Organization PAT · Code (Read & write) permission",
  },
];

/** Returns the user-facing authorization method for a saved connection. */
function credentialLabel(kind: string) {
  if (kind === "github_app") return "GitHub App";
  if (kind === "oauth") return "OAuth";
  return "PAT";
}

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
  const [connectionMethod, setConnectionMethod] =
    useState<ProviderConnectionMethod>("managed");
  const [showForm, setShowForm] = useState(
    !localMode && initialConnections.length === 0,
  );
  const [token, setToken] = useState("");
  const [account, setAccount] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [repositorySearch, setRepositorySearch] = useState("");
  const [connectionToDisconnect, setConnectionToDisconnect] =
    useState<Connection>();
  const [editingConnection, setEditingConnection] = useState<Connection>();
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    initialConnections[0]?.id ?? "",
  );
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(
    initialRepositories[0]?.id ?? "",
  );
  const [pendingIntakeMode, setPendingIntakeMode] = useState<IntakeMode>();
  const selectedRepository = repositories.find(
    ({ id }) => id === selectedRepositoryId,
  );
  const availableRepositories = api.provider.listAvailableRepositories.useQuery(
    { connectionId: selectedConnectionId },
    {
      enabled: Boolean(selectedConnectionId),
      staleTime: 60_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const openPullRequests = api.provider.listOpenPullRequests.useQuery(
    { repositoryId: selectedRepositoryId },
    {
      enabled: Boolean(
        selectedRepositoryId &&
          selectedRepository?.reviewIntakeMode === "manual",
      ),
      staleTime: 30_000,
      retry: false,
      refetchOnWindowFocus: false,
    },
  );
  const intakePreview = api.provider.previewRepositoryIntake.useQuery(
    {
      repositoryId: selectedRepositoryId,
      mode: pendingIntakeMode ?? "manual",
    },
    {
      enabled: Boolean(
        selectedRepositoryId &&
          pendingIntakeMode &&
          pendingIntakeMode !== selectedRepository?.reviewIntakeMode,
      ),
      retry: false,
      refetchOnWindowFocus: false,
    },
  );

  /** Invalidates provider-derived state shared by settings and onboarding. */
  function invalidateProviderState() {
    return Promise.all([
      utils.provider.listConnections.invalidate(),
      utils.provider.listImportedRepositories.invalidate(),
      utils.provider.listAvailableRepositories.invalidate(),
      utils.workspace.guidance.invalidate(),
    ]);
  }

  const connect = api.provider.connect.useMutation({
    onSuccess: (connection) => {
      if (connection) {
        setConnections((current) => [
          ...current.filter(({ id }) => id !== connection.id),
          connection,
        ]);
        setSelectedConnectionId(connection.id);
      }
      setToken("");
      setAccount("");
      setBaseUrl("");
      setEditingConnection(undefined);
      setConnectionMethod("managed");
      setShowForm(false);
      void invalidateProviderState();
      router.refresh();
      toast.success(
        editingConnection ? "Provider token replaced" : "Provider connected",
      );
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
          connectionName:
            connections.find(({ id }) => id === repository.connectionId)
              ?.displayName ?? "Provider connection",
          credentialKind:
            connections.find(({ id }) => id === repository.connectionId)
              ?.credentialKind ?? "local_pat",
          connectionId: repository.connectionId,
          webUrl: repository.webUrl,
          reviewIntakeMode: repository.reviewIntakeMode,
          intakeLastAttemptAt: repository.intakeLastAttemptAt,
          intakeLastReconciledAt: repository.intakeLastReconciledAt,
          intakeLastError: repository.intakeLastError,
        },
      ]);
      setSelectedRepositoryId(repository.id);
      void Promise.all([
        utils.provider.listImportedRepositories.invalidate(),
        utils.provider.listOpenPullRequests.invalidate(),
      ]);
      router.refresh();
      toast.success("Repository added");
    },
    onError: (error) => toast.error(error.message),
  });
  const disconnect = api.provider.disconnect.useMutation({
    onSuccess: ({ id, remoteCleanupComplete }) => {
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
      void Promise.all([
        invalidateProviderState(),
        utils.provider.listAvailableRepositories.invalidate(),
        utils.provider.listOpenPullRequests.invalidate(),
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
      ]);
      router.refresh();
      if (remoteCleanupComplete) {
        toast.success("Provider disconnected");
      } else {
        toast.warning(
          "Provider disconnected locally. The provider could not confirm every remote revocation; verify access in the provider's settings.",
        );
      }
    },
    onError: (error) => toast.error(error.message),
  });
  const syncPullRequest = api.review.sync.useMutation({
    onSuccess: (result) => {
      void Promise.all([
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
      ]);
      toast.success("Review synchronization queued", {
        description: `Durable sync ${result.syncId.slice(0, 8)} is running in the background.`,
      });
    },
    onError: (error) =>
      toast.error("Could not prepare review", {
        description: error.message,
      }),
  });
  const reconcileIntake = api.provider.reconcileRepositoryIntake.useMutation({
    onSuccess: (result) => {
      setRepositories((current) =>
        current.map((repository) =>
          repository.id === selectedRepositoryId
            ? {
                ...repository,
                intakeLastReconciledAt: new Date(),
                intakeLastError: null,
              }
            : repository,
        ),
      );
      void Promise.all([
        utils.provider.listImportedRepositories.invalidate(),
        utils.provider.listOpenPullRequests.invalidate(),
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
      ]);
      toast.success(
        result.queued > 0
          ? result.deferred > 0
            ? `${result.queued} review${result.queued === 1 ? "" : "s"} preparing · ${result.deferred} waiting`
            : `${result.queued} review${result.queued === 1 ? "" : "s"} queued`
          : "Pull-request intake is current",
        result.deferred > 0
          ? {
              description:
                "Waiting reviews will start automatically as each analysis finishes.",
            }
          : undefined,
      );
    },
    onError: (error) => {
      setRepositories((current) =>
        current.map((repository) =>
          repository.id === selectedRepositoryId
            ? { ...repository, intakeLastError: error.message }
            : repository,
        ),
      );
      void utils.provider.listImportedRepositories.invalidate();
      toast.error("Could not check pull requests", {
        description: error.message,
      });
    },
  });
  const updateIntake = api.provider.updateRepositoryIntake.useMutation({
    onSuccess: (result) => {
      setPendingIntakeMode(undefined);
      setRepositories((current) =>
        current.map((repository) =>
          repository.id === result.id
            ? {
                ...repository,
                reviewIntakeMode: result.reviewIntakeMode,
                intakeLastError: null,
              }
            : repository,
        ),
      );
      void utils.provider.listImportedRepositories.invalidate();
      toast.success("Pull-request intake updated");
      if (result.reviewIntakeMode !== "manual") {
        reconcileIntake.mutate({ repositoryId: result.id });
      }
    },
    onError: (error) =>
      toast.error("Could not update pull-request intake", {
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
  const automaticRepositoryCount = repositories.filter(
    (repository) => repository.reviewIntakeMode !== "manual",
  ).length;

  /** Derives a truthful connection state from the latest provider request. */
  const connectionStatus = (connection: Connection) => {
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
    if (connection.id !== selectedConnectionId) {
      return { label: "Saved", tone: "text-mist", dot: "bg-fog" };
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
  };

  /** Returns whether this connection can be recovered by replacing its token. */
  const canReplaceToken = (connection: Connection) =>
    supportsTokenReplacement(localMode, connection.credentialKind);

  /** Returns whether this connection can repeat its managed authorization. */
  const canReauthorize = (connection: Connection) =>
    supportsManagedReauthorization(localMode, connection.credentialKind);

  /** Opens the provider form in create mode. */
  const openNewConnectionForm = (nextProvider: Provider = provider) => {
    setEditingConnection(undefined);
    setProvider(nextProvider);
    setToken("");
    setAccount("");
    setBaseUrl("");
    setConnectionMethod(
      localMode || nextProvider === "azure_devops" ? "pat" : "managed",
    );
    connect.reset();
    setShowForm(true);
    requestAnimationFrame(() =>
      document
        .getElementById("provider-connection-form")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  /** Opens the token form with an existing connection's editable settings. */
  const openConnectionEditor = (connection: Connection) => {
    setEditingConnection(connection);
    setSelectedConnectionId(connection.id);
    setProvider(connection.provider);
    setToken("");
    setAccount(connection.displayName);
    setBaseUrl(connection.baseUrl ?? "");
    setConnectionMethod("pat");
    connect.reset();
    setShowForm(true);
    requestAnimationFrame(() =>
      document
        .getElementById("provider-connection-form")
        ?.scrollIntoView({ behavior: "smooth", block: "start" }),
    );
  };

  /** Closes and clears either connection form mode. */
  const closeConnectionForm = () => {
    setShowForm(false);
    setEditingConnection(undefined);
    setToken("");
    connect.reset();
  };

  /** Redirects SaaS users into a supported provider authorization flow. */
  const startHostedAuthorization = async (authorizationProvider: Provider) => {
    if (authorizationProvider === "azure_devops") return;
    setAuthorizationPending(true);
    try {
      const response = await fetch(
        `/api/integrations/${authorizationProvider}/start`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ redirectPath: "/settings/providers" }),
        },
      );
      const result = (await response.json()) as {
        authorizationUrl?: string;
        error?: string;
      };
      if (!response.ok || !result.authorizationUrl) {
        throw new Error(result.error ?? "Authorization could not be started");
      }
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setAuthorizationPending(false);
      toast.error(
        cause instanceof Error ? cause.message : "Authorization failed",
      );
    }
  };

  /** Opens and resets the GitHub connection form for a new token. */
  const showGitHubConnectionForm = () => {
    openNewConnectionForm("github");
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
              : "Use the provider's authorization flow, or connect with an encrypted access token when organization policy requires it."}
          </p>
        </div>
        {(connections.length > 0 || localMode) && (
          <Button
            variant="secondary"
            onClick={() =>
              showForm ? closeConnectionForm() : openNewConnectionForm()
            }
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

      <div className="mt-7 grid overflow-hidden rounded-2xl border border-line bg-surface/55 sm:grid-cols-3">
        <div className="border-b border-line px-5 py-4 sm:border-r sm:border-b-0">
          <p className="text-fog text-[10px] font-semibold tracking-[.14em] uppercase">
            Connections
          </p>
          <p className="mt-1 text-xl font-medium">{connections.length}</p>
        </div>
        <div className="border-b border-line px-5 py-4 sm:border-r sm:border-b-0">
          <p className="text-fog text-[10px] font-semibold tracking-[.14em] uppercase">
            Repositories
          </p>
          <p className="mt-1 text-xl font-medium">{repositories.length}</p>
        </div>
        <div className="px-5 py-4">
          <p className="text-fog text-[10px] font-semibold tracking-[.14em] uppercase">
            Automatic intake
          </p>
          <p className="mt-1 text-xl font-medium">{automaticRepositoryCount}</p>
        </div>
      </div>

      {showForm && (
        <section
          id="provider-connection-form"
          className="bg-surface mt-8 scroll-mt-6 rounded-3xl border border-line p-5 sm:p-7"
        >
          {editingConnection ? (
            <div className="border-line bg-surface-subtle rounded-2xl border p-4">
              <p className="text-sm font-medium">
                Replace token for {editingConnection.displayName}
              </p>
              <p className="text-mist mt-1 text-xs leading-5">
                The saved token is never displayed. Paste a replacement below;
                repositories and review history will stay connected.
              </p>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-3">
              {providers.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => {
                    setProvider(item.id);
                    setBaseUrl("");
                    setConnectionMethod(
                      localMode || item.id === "azure_devops"
                        ? "pat"
                        : "managed",
                    );
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
          {localMode ||
          provider === "azure_devops" ||
          connectionMethod === "pat" ? (
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
              <div className="flex justify-end">
                <Button
                  disabled={
                    !token ||
                    (provider === "azure_devops" && !baseUrl) ||
                    (requiresConnectionLabel && !account.trim()) ||
                    connect.isPending
                  }
                  onClick={() =>
                    connect.mutate({
                      connectionId: editingConnection?.id,
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
                  {editingConnection ? "Verify & replace" : "Verify & connect"}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-6 grid gap-4">
              <p className="text-mist text-sm leading-6">
                Authorization happens on the provider. ReviewDuck stores the
                resulting App or OAuth identity and never receives your
                password.
              </p>
              <div className="flex justify-end">
                <Button
                  disabled={authorizationPending}
                  onClick={() => startHostedAuthorization(provider)}
                >
                  {authorizationPending && (
                    <Loader2 className="size-4 animate-spin" />
                  )}
                  Authorize with{" "}
                  {providers.find(({ id }) => id === provider)?.label}
                </Button>
              </div>
            </div>
          )}
        </section>
      )}

      <section className="mt-10">
        <div className="mb-4">
          <p className="text-fog text-[10px] font-semibold tracking-[.14em] uppercase">
            Connected accounts
          </p>
          <p className="text-mist mt-1 text-xs">
            Select a connection below to verify access and browse repositories.
          </p>
        </div>
        <div className="space-y-3">
          {connections.map((connection) => {
            const status = connectionStatus(connection);
            const connectionError =
              connection.credentialStatus !== "active"
                ? `${connection.displayName}'s authorization is ${connection.credentialStatus}. Reconnect it to restore access.`
                : connection.id === selectedConnectionId &&
                    availableRepositories.isError
                  ? availableRepositories.error.message
                  : undefined;
            return (
              <div
                key={connection.id}
                className={`bg-surface/70 w-full overflow-hidden rounded-2xl border text-left transition ${
                  connection.id === selectedConnectionId
                    ? "border-lime/30"
                    : "border-line hover:border-line-strong"
                }`}
              >
                <div className="flex items-center gap-1 p-2">
                  <button
                    type="button"
                    aria-label={`Use ${connection.displayName}`}
                    onClick={() => setSelectedConnectionId(connection.id)}
                    className="flex min-w-0 flex-1 items-center gap-4 rounded-xl p-3 text-left"
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
                        <span className="border-line bg-surface-subtle text-fog rounded-full border px-2 py-0.5 text-[9px] font-medium uppercase">
                          {credentialLabel(connection.credentialKind)}
                        </span>
                        <span
                          className={`${status.tone} flex items-center gap-1.5 text-xs sm:hidden`}
                        >
                          <span
                            className={`${status.dot} size-1.5 rounded-full`}
                          />
                          {status.label}
                        </span>
                      </div>
                    </div>
                    <span
                      className={`${status.tone} hidden shrink-0 items-center gap-1.5 text-xs sm:flex`}
                    >
                      <span className={`${status.dot} size-1.5 rounded-full`} />
                      {status.label}
                    </span>
                  </button>
                  {canReplaceToken(connection) && (
                    <button
                      type="button"
                      aria-label={`Edit ${connection.displayName}`}
                      onClick={() => openConnectionEditor(connection)}
                      className="text-fog hover:text-cloud grid size-9 shrink-0 place-items-center rounded-full transition hover:bg-white/[.04]"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  )}
                  {canReauthorize(connection) && (
                    <button
                      type="button"
                      aria-label={`Reconnect ${connection.displayName}`}
                      disabled={authorizationPending}
                      onClick={() =>
                        startHostedAuthorization(connection.provider)
                      }
                      className="text-fog hover:text-cloud grid size-9 shrink-0 place-items-center rounded-full transition hover:bg-white/[.04]"
                    >
                      {authorizationPending ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                    </button>
                  )}
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
                {connectionError && (
                  <div className="border-coral/20 bg-coral/[.045] flex flex-col gap-3 border-t px-5 py-3 sm:flex-row sm:items-center">
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
                    {canReplaceToken(connection) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => openConnectionEditor(connection)}
                      >
                        <Pencil className="size-3.5" /> Replace token
                      </Button>
                    )}
                    {canReauthorize(connection) && (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={authorizationPending}
                        onClick={() =>
                          startHostedAuthorization(connection.provider)
                        }
                      >
                        {authorizationPending ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                        Reconnect{" "}
                        {connection.provider === "github" ? "GitHub" : "GitLab"}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {connectionToDisconnect && (
        <ConfirmationDialog
          title={`Disconnect ${connectionToDisconnect.displayName}?`}
          description={
            <>
              Imported repositories and their review history will be removed.
              {localMode
                ? " The locally encrypted provider credential will also be deleted."
                : connectionToDisconnect.credentialKind === "pat"
                  ? " The encrypted personal access token will also be deleted. You can revoke it at the provider as well."
                  : " The App/OAuth authorization record will also be deleted."}
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
            <h2 className="mt-2 text-xl font-medium">Repository access</h2>
            <p className="text-mist mt-1 text-xs leading-5">
              Add only repositories that should be available in this workspace.
            </p>
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
                      {availableRepositories.data.length} from this connection
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
              {localMode && selectedConnection?.provider === "github" && (
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
                  <div
                    role="alert"
                    className="border-coral/25 bg-coral/[.055] flex items-start gap-3 rounded-xl border px-4 py-3"
                  >
                    <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-cloud text-xs font-medium">
                        Repository access unavailable
                      </p>
                      <p className="text-mist mt-1 text-[11px] leading-5">
                        {availableRepositories.error.message}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      {selectedConnection &&
                        canReplaceToken(selectedConnection) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              openConnectionEditor(selectedConnection)
                            }
                          >
                            <Pencil className="size-3.5" /> Edit connection
                          </Button>
                        )}
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={availableRepositories.isFetching}
                        onClick={() => void availableRepositories.refetch()}
                      >
                        <RefreshCw
                          className={`size-3.5 ${
                            availableRepositories.isFetching
                              ? "animate-spin"
                              : ""
                          }`}
                        />
                        Retry
                      </Button>
                    </div>
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
                Automation
              </p>
              <h2 className="mt-2 text-xl font-medium">Pull-request intake</h2>
              <p className="text-mist mt-1 text-xs leading-5">
                Choose how each repository enters your review queue.
              </p>
            </div>
          </div>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center">
            <select
              value={selectedRepositoryId}
              onChange={(event) => setSelectedRepositoryId(event.target.value)}
              aria-label="Repository"
              className="bg-surface text-cloud h-11 min-w-0 flex-1 rounded-xl border border-line px-4 text-sm outline-none sm:max-w-md"
            >
              {repositories.map((repository) => (
                <option key={repository.id} value={repository.id}>
                  {repository.owner}/{repository.name}
                </option>
              ))}
            </select>
            {selectedRepository && (
              <a
                href={selectedRepository.webUrl}
                target="_blank"
                rel="noreferrer"
                className="text-mist hover:text-cloud inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line px-4 text-xs transition"
              >
                Open repository
                <ExternalLink className="size-3.5" />
              </a>
            )}
          </div>

          {selectedRepository && (
            <div className="bg-surface/70 mt-4 rounded-3xl border border-line p-5 sm:p-6">
              <div className="grid gap-3 lg:grid-cols-3">
                {[
                  {
                    mode: "manual" as const,
                    title: "Manual",
                    description:
                      "You choose which pull requests to prepare for review.",
                    icon: GitPullRequest,
                  },
                  {
                    mode: "assigned" as const,
                    title: "Assigned to me",
                    description:
                      "Prepare PRs where this account is a reviewer or assignee.",
                    icon: Users,
                  },
                  {
                    mode: "all" as const,
                    title: "Every open PR",
                    description:
                      "Prepare every new or updated pull request in this repository.",
                    icon: WandSparkles,
                  },
                ].map((option) => {
                  const active =
                    selectedRepository.reviewIntakeMode === option.mode;
                  const unsupported =
                    option.mode === "assigned" &&
                    selectedRepository.provider === "github" &&
                    selectedRepository.credentialKind === "github_app";
                  const Icon = option.icon;
                  return (
                    <button
                      type="button"
                      key={option.mode}
                      disabled={unsupported || updateIntake.isPending}
                      onClick={() => {
                        if (!active) setPendingIntakeMode(option.mode);
                      }}
                      className={`rounded-2xl border p-4 text-left transition ${
                        active
                          ? "border-cyan/35 bg-cyan/[.055]"
                          : "border-line bg-surface-subtle hover:border-line-strong"
                      } disabled:cursor-not-allowed disabled:opacity-45`}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <span
                          className={`grid size-8 place-items-center rounded-lg ${
                            active
                              ? "bg-cyan/10 text-cyan"
                              : "bg-surface text-mist"
                          }`}
                        >
                          <Icon className="size-4" />
                        </span>
                        <span
                          className={`grid size-4 place-items-center rounded-full border ${
                            active
                              ? "border-cyan bg-cyan text-ink"
                              : "border-line"
                          }`}
                        >
                          {active && <Check className="size-3" />}
                        </span>
                      </div>
                      <p className="mt-4 text-sm font-medium">{option.title}</p>
                      <p className="text-mist mt-1.5 text-[11px] leading-5">
                        {unsupported
                          ? "Unavailable for GitHub App installations because an App is not a human reviewer."
                          : option.description}
                      </p>
                    </button>
                  );
                })}
              </div>

              <div className="mt-5 flex flex-col gap-4 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-mist flex items-center gap-2 text-xs">
                    {selectedRepository.reviewIntakeMode === "manual" ? (
                      <>
                        <ShieldCheck className="text-lime size-3.5" />
                        New pull requests remain under your control.
                      </>
                    ) : (
                      <>
                        <Clock3 className="text-cyan size-3.5" />
                        {selectedRepository.intakeLastReconciledAt
                          ? `Last checked ${new Intl.DateTimeFormat(undefined, {
                              dateStyle: "medium",
                              timeStyle: "short",
                            }).format(
                              new Date(
                                selectedRepository.intakeLastReconciledAt,
                              ),
                            )}`
                          : "Waiting for the first automatic check."}
                      </>
                    )}
                  </p>
                  {selectedRepository.reviewIntakeMode === "all" && (
                    <p className="text-fog mt-1 text-[10px] leading-4">
                      This can increase provider, analysis, storage, and AI
                      usage on busy repositories.
                    </p>
                  )}
                </div>
                {selectedRepository.reviewIntakeMode !== "manual" && (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={reconcileIntake.isPending}
                    onClick={() =>
                      reconcileIntake.mutate({
                        repositoryId: selectedRepository.id,
                      })
                    }
                  >
                    <RefreshCw
                      className={`size-3.5 ${
                        reconcileIntake.isPending ? "animate-spin" : ""
                      }`}
                    />
                    Check now
                  </Button>
                )}
              </div>
              {selectedRepository.intakeLastError && (
                <div
                  role="alert"
                  className="border-coral/25 bg-coral/[.055] mt-4 flex gap-3 rounded-xl border px-4 py-3"
                >
                  <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
                  <div>
                    <p className="text-xs font-medium">
                      Automatic intake needs attention
                    </p>
                    <p className="text-mist mt-1 text-[11px] leading-5">
                      {selectedRepository.intakeLastError}
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}

          {pendingIntakeMode && selectedRepository && (
            <ConfirmationDialog
              title={
                pendingIntakeMode === "manual"
                  ? "Switch to manual intake?"
                  : pendingIntakeMode === "assigned"
                    ? "Prepare assigned pull requests?"
                    : "Prepare every open pull request?"
              }
              description={
                pendingIntakeMode === "manual" ? (
                  <>
                    ReviewDuck will stop adding new pull requests automatically.
                    Reviews already in your queue stay exactly where they are
                    and can be removed individually.
                  </>
                ) : intakePreview.isLoading ? (
                  <span className="flex items-center gap-2">
                    <Loader2 className="size-4 animate-spin" />
                    Checking the provider before anything is queued…
                  </span>
                ) : intakePreview.isError ? (
                  <span className="text-coral">
                    {intakePreview.error.message}
                  </span>
                ) : (
                  <>
                    <span className="block">
                      {pendingIntakeMode === "assigned"
                        ? "ReviewDuck will add pull requests assigned to or requesting review from this connected account."
                        : "ReviewDuck will add every open pull request in this repository."}
                    </span>
                    <span className="mt-3 block rounded-xl border border-line bg-surface-subtle px-3 py-2 text-xs">
                      {intakePreview.data?.matched ?? 0} currently match ·{" "}
                      {intakePreview.data?.alreadyPrepared ?? 0} already
                      prepared · {intakePreview.data?.newReviews ?? 0} new
                      {(intakePreview.data?.keptRemoved ?? 0) > 0 &&
                        ` · ${intakePreview.data?.keptRemoved ?? 0} remain removed`}
                    </span>
                    <span className="text-fog mt-3 block text-xs">
                      Future matches are added automatically. You can remove any
                      review from your queue or return to Manual at any time.
                    </span>
                  </>
                )
              }
              icon={
                pendingIntakeMode === "assigned" ? (
                  <Users className="text-cyan size-4" />
                ) : pendingIntakeMode === "all" ? (
                  <WandSparkles className="text-coral size-4" />
                ) : (
                  <ShieldCheck className="text-lime size-4" />
                )
              }
              iconClassName={
                pendingIntakeMode === "assigned"
                  ? "bg-cyan/10"
                  : pendingIntakeMode === "manual"
                    ? "bg-lime/10"
                    : undefined
              }
              confirmLabel={
                pendingIntakeMode === "manual"
                  ? "Use manual intake"
                  : `Enable ${
                      pendingIntakeMode === "assigned"
                        ? "assigned intake"
                        : "all PR intake"
                    }`
              }
              confirmDisabled={intakePreview.isLoading || intakePreview.isError}
              pending={updateIntake.isPending}
              pendingLabel={
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Updating…
                </>
              }
              onCancel={() => setPendingIntakeMode(undefined)}
              onConfirm={() =>
                updateIntake.mutate({
                  repositoryId: selectedRepository.id,
                  mode: pendingIntakeMode,
                })
              }
            />
          )}

          {selectedRepository?.reviewIntakeMode === "manual" ? (
            <>
              <div className="mt-10 flex items-end justify-between border-t border-line pt-8">
                <div>
                  <p className="text-fog text-[10px] font-semibold tracking-[.14em] uppercase">
                    Open pull requests
                  </p>
                  <h3 className="mt-2 text-base font-medium">
                    Available to prepare
                  </h3>
                </div>
                <button
                  type="button"
                  aria-label="Refresh pull requests"
                  onClick={() => void openPullRequests.refetch()}
                  className="text-mist hover:text-cloud grid size-9 place-items-center rounded-lg border border-line transition"
                >
                  <RefreshCw
                    className={`size-4 ${
                      openPullRequests.isFetching ? "animate-spin" : ""
                    }`}
                  />
                </button>
              </div>
              <div className="mt-4 space-y-2">
                {openPullRequests.isLoading && (
                  <div className="grid h-24 place-items-center">
                    <Loader2 className="text-cyan size-4 animate-spin" />
                  </div>
                )}
                {openPullRequests.isError && (
                  <div
                    role="alert"
                    className="border-coral/25 bg-coral/[.055] flex items-start gap-3 rounded-2xl border p-5"
                  >
                    <CircleAlert className="text-coral mt-0.5 size-4 shrink-0" />
                    <div>
                      <p className="text-xs font-medium">
                        Pull requests could not be loaded
                      </p>
                      <p className="text-mist mt-1 text-[11px] leading-5">
                        {openPullRequests.error.message}
                      </p>
                    </div>
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
                      {selectedRepository?.reviewIntakeMode === "manual"
                        ? "Prepare review"
                        : "Prepare now"}
                    </Button>
                  </div>
                ))}
                {openPullRequests.data?.length === 0 && (
                  <p className="text-mist rounded-2xl border border-dashed border-line p-8 text-center text-sm">
                    No open pull requests in this repository.
                  </p>
                )}
              </div>
            </>
          ) : (
            <div className="border-cyan/15 bg-cyan/[.025] mt-8 flex flex-col gap-3 rounded-2xl border px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium">
                  Automatic intake is managing this repository
                </p>
                <p className="text-mist mt-1 text-xs leading-5">
                  Matching PRs go directly to your review queue. The manual
                  preparation list is hidden while automation is enabled.
                </p>
              </div>
              <Button asChild size="sm" variant="secondary">
                <Link href="/dashboard">Open review queue</Link>
              </Button>
            </div>
          )}
        </section>
      )}
    </PageContainer>
  );
}
