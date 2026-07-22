import { timingSafeEqual } from "node:crypto";
import { fingerprintSecret } from "~/server/security/encryption";
import type { AiProtocol } from "~/validators/ai";

const TOKEN_VERSION = 1;
const TOKEN_TTL_MS = 10 * 60 * 1_000;

export interface VerifiedAiConfiguration {
  provider: string;
  model: string;
  apiProtocol: AiProtocol;
  apiKey?: string;
  headers: Record<string, string>;
  baseUrl?: string;
  contextWindow: number;
  maxTokens: number;
  storeResponses: boolean;
}

interface VerificationPayload {
  version: typeof TOKEN_VERSION;
  workspaceId: string;
  userId: string;
  fingerprint: string;
  expiresAt: number;
}

/** Creates a stable fingerprint for a model configuration. */
function configurationFingerprint(
  configuration: VerifiedAiConfiguration,
  secret: string,
) {
  const headers = Object.fromEntries(
    Object.entries(configuration.headers).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return fingerprintSecret(
    JSON.stringify({ ...configuration, headers }),
    secret,
  );
}

/** Creates a keyed signature for configuration verification data. */
function signature(value: string, secret: string) {
  return fingerprintSecret(`ai-configuration-verification:${value}`, secret);
}

/** Issues a signed proof for a successfully tested model configuration. */
export function createAiConfigurationVerification(
  configuration: VerifiedAiConfiguration,
  scope: { workspaceId: string; userId: string },
  secret: string,
  now = Date.now(),
) {
  const payload: VerificationPayload = {
    version: TOKEN_VERSION,
    ...scope,
    fingerprint: configurationFingerprint(configuration, secret),
    expiresAt: now + TOKEN_TTL_MS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString(
    "base64url",
  );
  return `${encodedPayload}.${signature(encodedPayload, secret)}`;
}

/** Validates a model configuration against its signed verification proof. */
export function verifyAiConfiguration(
  token: string,
  configuration: VerifiedAiConfiguration,
  scope: { workspaceId: string; userId: string },
  secret: string,
  now = Date.now(),
) {
  const [encodedPayload, providedSignature] = token.split(".");
  if (!encodedPayload || !providedSignature) return false;

  const expectedSignature = signature(encodedPayload, secret);
  const provided = Buffer.from(providedSignature);
  const expected = Buffer.from(expectedSignature);
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  ) {
    return false;
  }

  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<VerificationPayload>;
    return (
      payload.version === TOKEN_VERSION &&
      payload.workspaceId === scope.workspaceId &&
      payload.userId === scope.userId &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt >= now &&
      payload.fingerprint === configurationFingerprint(configuration, secret)
    );
  } catch {
    return false;
  }
}
