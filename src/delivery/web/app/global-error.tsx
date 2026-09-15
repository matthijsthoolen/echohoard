"use client";

import { ErrorPage } from "../components/error-page";

export default function GlobalError({ reset }: { readonly reset: () => void }) {
  return (
    <html lang="en">
      <body>
        <ErrorPage kind="unexpected-failure" reset={reset} />
      </body>
    </html>
  );
}
