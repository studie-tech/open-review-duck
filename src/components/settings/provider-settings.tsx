"use client";

import {
  ArrowLeft,
  Loader2,
  PlugZap,
  ShieldCheck,
  Trash2,
  Users,
  WandSparkles,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "~/components/page-container";
import { ConnectionDetail } from "~/components/settings/connection-detail";
import {
  type Connection,
  type ImportedRepository,
  type IntakeMode,
  type Provider,
  providers,
  type SettingsSelection,
} from "~/components/settings/provider-common";
import {
  ConnectionFormDialog,
  type ConnectionFormMode,
} from "~/components/settings/provider-connection-form";
import { ProviderRail } from "~/components/settings/provider-rail";
import { RepositoryDetail } from "~/components/settings/repository-detail";
import { Button } from "~/components/ui/button";
import { ConfirmationDialog } from "~/components/ui/confirmation-dialog";
import {
  supportsManagedReauthorization,
  supportsTokenReplacement,
} from "~/lib/provider-credential-recovery";
import { cn } from "~/lib/utils";
import { api } from "~/trpc/react";

/** Renders the provider settings console. */
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
  const [selection, setSelection] = useState<SettingsSelection | undefined>(
    initialConnections[0]
      ? { kind: "connection", id: initialConnections[0].id }
      : undefined,
  );
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  const [railSearch, setRailSearch] = useState("");
  const [formMode, setFormMode] = useState<ConnectionFormMode>();
  const [authorizationPending, setAuthorizationPending] = useState(false);
  const [connectionToDisconnect, setConnectionToDisconnect] =
    useState<Connection>();
  const [repositoryToRemove, setRepositoryToRemove] =
    useState<ImportedRepository>();
  const [pendingIntake, setPendingIntake] = useState<{
    repositoryId: string;
    mode: IntakeMode;
  }>();

  const selectedConnection =
    selection?.kind === "connection"
      ? connections.find(({ id }) => id === selection.id)
      : undefined;
  const selectedRepository =
    selection?.kind === "repository"
      ? repositories.find(({ id }) => id === selection.id)
      : undefined;
  const pendingIntakeRepository = pendingIntake
    ? repositories.find(({ id }) => id === pendingIntake.repositoryId)
    : undefined;

  useEffect(() => {
    if (selection && !selectedConnection && !selectedRepository) {
      setSelection(
        connections[0]
          ? { kind: "connection", id: connections[0].id }
          : undefined,
      );
    }
  }, [selection, selectedConnection, selectedRepository, connections]);

  const intakePreview = api.provider.previewRepositoryIntake.useQuery(
    {
      repositoryId: pendingIntake?.repositoryId ?? "",
      mode: pendingIntake?.mode ?? "manual",
    },
    {
      enabled: Boolean(
        pendingIntake &&
          pendingIntakeRepository &&
          pendingIntake.mode !== "manual" &&
          pendingIntake.mode !== pendingIntakeRepository.reviewIntakeMode,
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
      utils.provider.listUnimportedPullRequests.invalidate(),
      utils.workspace.guidance.invalidate(),
    ]);
  }

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
      setSelection(
        remainingConnections[0]
          ? { kind: "connection", id: remainingConnections[0].id }
          : undefined,
      );
      void Promise.all([
        invalidateProviderState(),
        utils.provider.listOpenPullRequests.invalidate(),
        utils.provider.listUnimportedPullRequests.invalidate(),
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
  const removeRepository = api.provider.deleteRepositoryData.useMutation({
    onSuccess: (_result, variables) => {
      const removed = repositories.find(
        ({ id }) => id === variables.repositoryId,
      );
      setRepositoryToRemove(undefined);
      setRepositories((current) =>
        current.filter(({ id }) => id !== variables.repositoryId),
      );
      const nextConnectionId = removed?.connectionId ?? connections[0]?.id;
      setSelection(
        nextConnectionId
          ? { kind: "connection", id: nextConnectionId }
          : undefined,
      );
      void Promise.all([
        invalidateProviderState(),
        utils.provider.listOpenPullRequests.invalidate(),
        utils.provider.listUnimportedPullRequests.invalidate(),
        utils.review.activeSyncs.invalidate(),
        utils.review.dashboard.invalidate(),
      ]);
      router.refresh();
      toast.success("Repository removed");
    },
    onError: (error) => toast.error(error.message),
  });
  const reconcileIntake = api.provider.reconcileRepositoryIntake.useMutation({
    onSuccess: (result, variables) => {
      setRepositories((current) =>
        current.map((repository) =>
          repository.id === variables.repositoryId
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
        utils.provider.listUnimportedPullRequests.invalidate(),
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
    onError: (error, variables) => {
      setRepositories((current) =>
        current.map((repository) =>
          repository.id === variables.repositoryId
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
      setPendingIntake(undefined);
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
      void Promise.all([
        utils.provider.listImportedRepositories.invalidate(),
        utils.provider.listUnimportedPullRequests.invalidate(),
      ]);
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

  /** Returns whether this connection can be recovered by replacing its token. */
  const canReplaceToken = (connection: Connection) =>
    supportsTokenReplacement(localMode, connection.credentialKind);

  /** Returns whether this connection can repeat its managed authorization. */
  const canReauthorize = (connection: Connection) =>
    supportsManagedReauthorization(
      localMode,
      connection.credentialKind,
      connection.provider,
    );

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

  /** Focuses one rail entry and opens the detail pane on small screens. */
  function handleSelect(next: SettingsSelection) {
    setSelection(next);
    setMobileDetailOpen(true);
  }

  /** Records a verified connection and focuses it in the console. */
  function handleConnected(connection: Connection, replaced: boolean) {
    setConnections((current) => [
      ...current.filter(({ id }) => id !== connection.id),
      connection,
    ]);
    setSelection({ kind: "connection", id: connection.id });
    setMobileDetailOpen(true);
    setFormMode(undefined);
    void invalidateProviderState();
    router.refresh();
    toast.success(replaced ? "Provider token replaced" : "Provider connected");
  }

  /** Records an imported repository and focuses its detail pane. */
  function handleImported(repository: ImportedRepository) {
    setRepositories((current) => [
      ...current.filter(({ id }) => id !== repository.id),
      repository,
    ]);
    setSelection({ kind: "repository", id: repository.id });
    void Promise.all([
      utils.provider.listImportedRepositories.invalidate(),
      utils.provider.listOpenPullRequests.invalidate(),
      utils.provider.listUnimportedPullRequests.invalidate(),
    ]);
    router.refresh();
    toast.success("Repository added");
  }

  const automaticRepositoryCount = repositories.filter(
    (repository) => repository.reviewIntakeMode !== "manual",
  ).length;

  return (
    <PageContainer className="flex flex-col gap-6 py-6 sm:py-8 lg:h-[calc(100dvh-4rem)] lg:min-h-0">
      <div
        className={cn(
          "shrink-0",
          mobileDetailOpen && connections.length > 0 && "hidden md:block",
        )}
      >
        <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
          Integrations
        </p>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <h1 className="font-editorial text-3xl font-medium tracking-[-.04em]">
            Code providers
          </h1>
          {connections.length > 0 && (
            <p className="text-fog text-xs">
              {connections.length}{" "}
              {connections.length === 1 ? "connection" : "connections"} ·{" "}
              {repositories.length}{" "}
              {repositories.length === 1 ? "repository" : "repositories"} ·{" "}
              {automaticRepositoryCount} automatic
            </p>
          )}
        </div>
        <p className="text-mist mt-1 text-sm">
          {localMode
            ? "Access tokens are encrypted before they are stored in your local data volume."
            : "Use the provider's authorization flow, or connect with an encrypted access token when organization policy requires it."}
        </p>
      </div>

      {connections.length === 0 ? (
        <div className="grid flex-1 place-items-center rounded-3xl border border-dashed border-line px-6 py-16">
          <div className="max-w-md text-center">
            <span className="bg-lime/10 text-lime mx-auto grid size-12 place-items-center rounded-2xl">
              <PlugZap className="size-6" />
            </span>
            <h2 className="mt-5 text-xl font-medium">
              Connect your first code provider
            </h2>
            <p className="text-mist mt-2 text-sm leading-6">
              Link GitHub, GitLab, or Azure DevOps to bring repositories and
              their pull requests into your review workspace.
            </p>
            <div className="mt-6 flex flex-wrap justify-center gap-2">
              {providers.map((provider) => (
                <Button
                  key={provider.id}
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setFormMode({ kind: "create", provider: provider.id })
                  }
                >
                  {provider.label}
                </Button>
              ))}
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 items-start gap-6 md:grid-cols-[280px_minmax(0,1fr)] lg:grid-rows-[minmax(0,1fr)] lg:items-stretch">
          <ProviderRail
            className={cn(
              "md:min-h-0 lg:h-full",
              mobileDetailOpen && "hidden md:flex",
            )}
            connections={connections}
            repositories={repositories}
            selection={selection}
            search={railSearch}
            onSearchChange={setRailSearch}
            onSelect={handleSelect}
            onAddConnection={() => setFormMode({ kind: "create" })}
          />
          <div
            className={cn(
              "min-h-0 md:block lg:h-full lg:overflow-y-auto lg:pr-1 lg:pb-2",
              !mobileDetailOpen && "hidden",
            )}
          >
            <button
              type="button"
              onClick={() => setMobileDetailOpen(false)}
              className="text-mist hover:text-cloud mb-4 flex items-center gap-2 text-xs transition md:hidden"
            >
              <ArrowLeft className="size-3.5" /> All connections
            </button>
            {selectedConnection && (
              <ConnectionDetail
                key={selectedConnection.id}
                connection={selectedConnection}
                importedRepositories={repositories.filter(
                  ({ connectionId }) => connectionId === selectedConnection.id,
                )}
                localMode={localMode}
                authorizationPending={authorizationPending}
                canReauthorize={canReauthorize(selectedConnection)}
                canReplaceToken={canReplaceToken(selectedConnection)}
                onReauthorize={() =>
                  void startHostedAuthorization(selectedConnection.provider)
                }
                onReplaceToken={() =>
                  setFormMode({
                    kind: "replace",
                    connection: selectedConnection,
                  })
                }
                onDisconnect={() =>
                  setConnectionToDisconnect(selectedConnection)
                }
                onImported={handleImported}
                onSelectRepository={(repositoryId) =>
                  handleSelect({ kind: "repository", id: repositoryId })
                }
                onAddConnection={() =>
                  setFormMode({
                    kind: "create",
                    provider: selectedConnection.provider,
                  })
                }
              />
            )}
            {selectedRepository && (
              <RepositoryDetail
                key={selectedRepository.id}
                repository={selectedRepository}
                intakeUpdatePending={updateIntake.isPending}
                reconcilePending={reconcileIntake.isPending}
                onReconcile={() =>
                  reconcileIntake.mutate({
                    repositoryId: selectedRepository.id,
                  })
                }
                onRemove={() => setRepositoryToRemove(selectedRepository)}
                onRequestIntakeChange={(mode) =>
                  setPendingIntake({
                    repositoryId: selectedRepository.id,
                    mode,
                  })
                }
              />
            )}
          </div>
        </div>
      )}

      {formMode && (
        <ConnectionFormDialog
          key={
            formMode.kind === "replace"
              ? `replace-${formMode.connection.id}`
              : `create-${formMode.provider ?? "any"}`
          }
          mode={formMode}
          localMode={localMode}
          connections={connections}
          authorizationPending={authorizationPending}
          onAuthorize={(provider) => void startHostedAuthorization(provider)}
          onClose={() => setFormMode(undefined)}
          onConnected={handleConnected}
        />
      )}

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

      {repositoryToRemove && (
        <ConfirmationDialog
          title={`Remove ${repositoryToRemove.owner}/${repositoryToRemove.name}?`}
          description="Prepared reviews, review history, and stored snapshots for this repository will be deleted from ReviewDuck. The repository itself is not affected on the provider, and you can add it again later."
          confirmLabel="Remove repository"
          confirmVariant="danger"
          pendingLabel={
            <>
              <Loader2 className="size-4 animate-spin" />
              Removing…
            </>
          }
          pending={removeRepository.isPending}
          icon={<Trash2 className="size-4 text-red-500 dark:text-red-300" />}
          iconClassName="bg-red-400/10"
          onCancel={() => setRepositoryToRemove(undefined)}
          onConfirm={() =>
            removeRepository.mutate({
              repositoryId: repositoryToRemove.id,
            })
          }
        />
      )}

      {pendingIntake && pendingIntakeRepository && (
        <ConfirmationDialog
          title={
            pendingIntake.mode === "manual"
              ? "Switch to manual intake?"
              : pendingIntake.mode === "assigned"
                ? "Prepare assigned pull requests?"
                : "Prepare every open pull request?"
          }
          description={
            pendingIntake.mode === "manual" ? (
              <>
                ReviewDuck will stop adding new pull requests automatically.
                Reviews already in your queue stay exactly where they are and
                can be removed individually.
              </>
            ) : intakePreview.isLoading ? (
              <span className="flex items-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                Checking the provider before anything is queued…
              </span>
            ) : intakePreview.isError ? (
              <span className="text-coral">{intakePreview.error.message}</span>
            ) : (
              <>
                <span className="block">
                  {pendingIntake.mode === "assigned"
                    ? "ReviewDuck will add pull requests assigned to or requesting review from this connected account."
                    : "ReviewDuck will add every open pull request in this repository."}
                </span>
                <span className="mt-3 block rounded-xl border border-line bg-surface-subtle px-3 py-2 text-xs">
                  {intakePreview.data?.matched ?? 0} currently match ·{" "}
                  {intakePreview.data?.alreadyPrepared ?? 0} already prepared ·{" "}
                  {intakePreview.data?.newReviews ?? 0} new
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
            pendingIntake.mode === "assigned" ? (
              <Users className="text-cyan size-4" />
            ) : pendingIntake.mode === "all" ? (
              <WandSparkles className="text-coral size-4" />
            ) : (
              <ShieldCheck className="text-lime size-4" />
            )
          }
          iconClassName={
            pendingIntake.mode === "assigned"
              ? "bg-cyan/10"
              : pendingIntake.mode === "manual"
                ? "bg-lime/10"
                : undefined
          }
          confirmLabel={
            pendingIntake.mode === "manual"
              ? "Use manual intake"
              : `Enable ${
                  pendingIntake.mode === "assigned"
                    ? "assigned intake"
                    : "all PR intake"
                }`
          }
          confirmDisabled={
            pendingIntake.mode !== "manual" &&
            (intakePreview.isLoading || intakePreview.isError)
          }
          pending={updateIntake.isPending}
          pendingLabel={
            <>
              <Loader2 className="size-4 animate-spin" />
              Updating…
            </>
          }
          onCancel={() => setPendingIntake(undefined)}
          onConfirm={() =>
            updateIntake.mutate({
              repositoryId: pendingIntake.repositoryId,
              mode: pendingIntake.mode,
            })
          }
        />
      )}
    </PageContainer>
  );
}
