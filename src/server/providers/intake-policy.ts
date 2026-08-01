/** Reports whether a connection can represent one human reviewer's identity. */
export function supportsAssignedIntake(connection: {
  provider: "github" | "gitlab" | "azure_devops";
  credentialKind: string;
}) {
  return !(
    connection.provider === "github" &&
    connection.credentialKind === "github_app"
  );
}
