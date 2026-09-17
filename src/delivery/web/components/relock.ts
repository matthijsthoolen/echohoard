export async function relockProtectedSession(fetcher: typeof fetch = fetch): Promise<void> {
  const response = await fetcher("/auth/unlock/relock", {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("relock unavailable");
}

/** Beacon is a delivery fallback for lifecycle navigation; the server endpoint
 * remains authoritative and every protected read still validates the grant. */
export function sendRelockBeacon(): void {
  const body = new Blob([], { type: "text/plain" });
  if (!navigator.sendBeacon("/auth/unlock/relock", body)) void relockProtectedSession();
}
