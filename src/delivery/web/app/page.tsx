import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getWebRuntime } from "../runtime";
import ArchiveShell from "./archive-shell";

export const dynamic = "force-dynamic";

export default async function Home() {
  const runtime = getWebRuntime();
  const cookieHeader = (await cookies()).toString();
  const principal = await runtime?.auth.principalForRequest(
    new Request("http://echohoard.local/", {
      headers: { cookie: cookieHeader },
    }),
  );

  if (!principal) redirect("/auth/login");

  return <ArchiveShell />;
}
