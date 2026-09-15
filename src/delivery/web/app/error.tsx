"use client";

import { ErrorPage } from "../components/error-page";

export default function Error({ reset }: { readonly reset: () => void }) {
  return <ErrorPage kind="unexpected-failure" reset={reset} />;
}
