import { describe, expect, it } from "vitest";
import {
  githubViewerCanMerge,
  providerConnectionRecovery,
  providerPermissionRecovery,
  providerRequiredAccess,
  providerSettingsHref,
} from "./provider-permission-recovery";

describe("providerSettingsHref", () => {
  it("focuses the connection and can open token replacement", () => {
    expect(providerSettingsHref("conn-1")).toBe(
      "/settings/providers?connection=conn-1",
    );
    expect(providerSettingsHref("conn-1", "token")).toBe(
      "/settings/providers?connection=conn-1&repair=token",
    );
  });
});

describe("githubViewerCanMerge", () => {
  it("treats a missing permission object as unknown and allows merge", () => {
    expect(githubViewerCanMerge()).toBe(true);
  });

  it("requires write, maintain, or admin access", () => {
    expect(githubViewerCanMerge({})).toBe(false);
    expect(githubViewerCanMerge({ push: true })).toBe(true);
    expect(githubViewerCanMerge({ maintain: true })).toBe(true);
    expect(githubViewerCanMerge({ admin: true })).toBe(true);
  });
});

describe("providerConnectionRecovery", () => {
  it("offers token replacement locally and hosted reconnect for managed apps", () => {
    expect(
      providerConnectionRecovery(true, {
        id: "local",
        credentialKind: "local_pat",
        provider: "github",
      }),
    ).toEqual({
      connectionId: "local",
      credentialKind: "local_pat",
      canReplaceToken: true,
      canReconnect: false,
    });
    expect(
      providerConnectionRecovery(false, {
        id: "hosted",
        credentialKind: "github_app",
        provider: "github",
      }),
    ).toEqual({
      connectionId: "hosted",
      credentialKind: "github_app",
      canReplaceToken: false,
      canReconnect: true,
    });
  });
});

describe("providerPermissionRecovery", () => {
  it("sends token connections to replace the credential with merge access", () => {
    const recovery = providerPermissionRecovery("github", "merge", {
      connectionId: "conn-1",
      credentialKind: "pat",
      canReplaceToken: true,
      canReconnect: false,
    });

    expect(recovery.title).toMatch(/cannot merge/i);
    expect(recovery.settingsLabel).toBe("Update token permissions");
    expect(recovery.settingsHref).toBe(
      "/settings/providers?connection=conn-1&repair=token",
    );
    expect(recovery.requiredAccess).toBe("Contents: Read and write");
    expect(recovery.finishLabel).toBe("Merge on GitHub");
    expect(recovery.reconnect).toBe(false);
  });

  it("reconnects a GitHub App so a new token can include Contents write", () => {
    const recovery = providerPermissionRecovery("github", "merge", {
      connectionId: "app",
      credentialKind: "github_app",
      canReplaceToken: false,
      canReconnect: true,
    });

    expect(recovery.title).toMatch(/cannot merge/i);
    expect(recovery.description).toMatch(/reconnect/i);
    expect(recovery.reconnect).toBe(true);
    expect(recovery.settingsLabel).toBe("Reconnect GitHub");
  });

  it("reconnects GitLab OAuth when merge permission is missing", () => {
    const recovery = providerPermissionRecovery("gitlab", "merge", {
      connectionId: "gl",
      credentialKind: "oauth",
      canReplaceToken: false,
      canReconnect: true,
    });

    expect(recovery.settingsLabel).toBe("Reconnect GitLab");
    expect(recovery.reconnect).toBe(true);
    expect(recovery.requiredAccess).toBe("api scope and Developer or higher");
  });

  it("documents Azure complete access and token replacement", () => {
    expect(providerRequiredAccess("azure_devops", "merge")).toBe(
      "Code: Read & write",
    );
    const recovery = providerPermissionRecovery("azure_devops", "merge", {
      connectionId: "ado",
      credentialKind: "pat",
      canReplaceToken: true,
      canReconnect: false,
    });
    expect(recovery.finishLabel).toBe("Complete on Azure DevOps");
    expect(recovery.settingsLabel).toBe("Update token permissions");
  });

  it("explains GitHub App personal review and generic sync failures", () => {
    expect(
      providerPermissionRecovery("github", "review", {
        connectionId: "app",
        credentialKind: "github_app",
        canReplaceToken: false,
        canReconnect: true,
      }).description,
    ).toMatch(/personal approval/i);
    expect(
      providerPermissionRecovery("github", "sync", {
        connectionId: "conn-1",
        credentialKind: "pat",
        canReplaceToken: true,
        canReconnect: false,
      }).settingsLabel,
    ).toBe("Open provider settings");
    expect(providerRequiredAccess("github", "sync")).toBe(
      "Contents: Read-only and Pull requests: Read-only",
    );
    expect(providerRequiredAccess("gitlab", "sync")).toBe(
      "api or read_api scope",
    );
    expect(providerRequiredAccess("azure_devops", "sync")).toBe("Code: Read");
  });
});
