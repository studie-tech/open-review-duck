import "server-only";

import { env } from "~/env";
import type { DeploymentMode } from "~/lib/deployment";
import { validateDeploymentConfiguration } from "./deployment-validation.js";

let deploymentConfigurationValidated = false;

/** Returns the explicitly configured application deployment mode. */
function deploymentMode(): DeploymentMode {
  return env.DEPLOYMENT_MODE;
}

/** Returns whether this process is a trusted, single-user local installation. */
export function isLocalDeployment() {
  return deploymentMode() === "local";
}

/** Fails early when the selected deployment is missing mandatory configuration. */
export function assertDeploymentConfigured() {
  if (deploymentConfigurationValidated) return;
  validateDeploymentConfiguration(env);
  deploymentConfigurationValidated = true;
}
