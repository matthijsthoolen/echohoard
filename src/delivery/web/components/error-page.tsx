"use client";

import Image from "next/image";
import { ECHOHOARD_VERSION } from "../../../application/version";
import { getErrorDescriptor, type ErrorKind } from "../error-registry";

interface ErrorPageProps {
  readonly kind: ErrorKind;
  readonly reset?: () => void;
}

export function ErrorPage({ kind, reset }: ErrorPageProps) {
  const descriptor = getErrorDescriptor(kind);
  return (
    <main className="error-page">
      <a className="skip-link" href="#error-content">
        Skip to error details
      </a>
      <div className="error-art">
        <Image
          src={descriptor.image}
          alt={descriptor.imageAlt}
          width={1672}
          height={941}
          priority
        />
      </div>
      <section className="error-copy" id="error-content" aria-labelledby="error-title">
        <p className="error-code">{descriptor.code || "ERROR"}</p>
        <h1 id="error-title">{descriptor.title}</h1>
        <p className="error-description">{descriptor.description}</p>
        <div className="error-actions">
          {reset ? (
            <button className="button" type="button" onClick={reset}>
              Try again
            </button>
          ) : null}
          <a className="button button-primary" href={descriptor.primaryAction.href}>
            {descriptor.primaryAction.label}
          </a>
        </div>
        <p className="error-version">v{ECHOHOARD_VERSION}</p>
      </section>
    </main>
  );
}
