export async function relockProtectedSession(fetcher: typeof fetch = fetch): Promise<void> {
  await fetcher("/auth/unlock/relock", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { Accept: "application/json" },
  });
}

/** Beacon is a delivery fallback for lifecycle navigation; the server endpoint
 * remains authoritative and every protected read still validates the grant. */
export function sendRelockBeacon(): void {
  const body = new Blob([], { type: "text/plain" });
  if (!navigator.sendBeacon("/auth/unlock/relock", body)) void relockProtectedSession();
}
