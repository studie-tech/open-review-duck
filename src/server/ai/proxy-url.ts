/** Joins an SDK request path onto a configured provider URL without duplicating shared segments. */
export function providerProxyTarget(
  configuredBaseUrl: string,
  requestPath: string[],
) {
  const target = new URL(configuredBaseUrl);
  const configuredSegments = target.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment));
  const requestedSegments = requestPath.filter(Boolean);
  const maximumOverlap = Math.min(
    configuredSegments.length,
    requestedSegments.length,
  );
  let overlap = 0;
  for (let size = maximumOverlap; size > 0; size -= 1) {
    const configuredTail = configuredSegments.slice(-size);
    const requestedHead = requestedSegments.slice(0, size);
    if (
      configuredTail.every((segment, index) => segment === requestedHead[index])
    ) {
      overlap = size;
      break;
    }
  }

  const remaining = requestedSegments
    .slice(overlap)
    .map((segment) => encodeURIComponent(segment));
  if (remaining.length > 0) {
    target.pathname = `${target.pathname.replace(/\/+$/, "")}/${remaining.join("/")}`;
  }
  return target;
}
