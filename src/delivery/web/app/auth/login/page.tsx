import Image from "next/image";
import { ECHOHOARD_VERSION } from "../../../../../application/version";
import { getWebRuntime } from "../../../runtime";

export default async function LoginPage() {
  const runtime = getWebRuntime();
  let setupPhase = false;
  if (runtime) {
    try {
      setupPhase = (await runtime.auth.bootstrapState()) === "setup";
    } catch {
      setupPhase = false;
    }
  }
  return (
    <main className="auth-page">
      <div className="auth-card">
        <Image
          className="auth-hero-logo"
          src="/brand/echohoard-large.png"
          alt="EchoHoard"
          width={420}
          height={420}
          priority
        />

        <div className="auth-copy">
          <h1>Welcome back</h1>
          {setupPhase ? (
            <p className="auth-setup" role="status">
              Initial setup · your first successful login becomes the owner.
            </p>
          ) : null}
        </div>

        <a className="auth-submit" href="/auth/login/start">
          <span>Continue with Authentik</span>
          <span aria-hidden="true">→</span>
        </a>

        <p className="auth-version">v{ECHOHOARD_VERSION}</p>
      </div>
    </main>
  );
}
