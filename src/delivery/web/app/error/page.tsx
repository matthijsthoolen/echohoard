import { ErrorPage } from "../../components/error-page";
import { getErrorDescriptor } from "../../error-registry";

export const dynamic = "force-dynamic";

export default async function ErrorRoute({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly kind?: string }>;
}) {
  const { kind } = await searchParams;
  return <ErrorPage kind={getErrorDescriptor(kind).kind} />;
}
