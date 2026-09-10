export default function LoginPage() {
  return (
    <main className="auth-page">
      <div className="auth-card">
        <a className="auth-brand" href="/" aria-label="EchoHoard home">
          <span className="auth-brand-mark" aria-hidden="true">
            E
          </span>
          <span>EchoHoard</span>
        </a>

        <div className="auth-copy">
          <p className="eyebrow">Private archive</p>
          <h1>Welcome back</h1>
          <p>Sign in to browse your conversations, people, and preserved media.</p>
        </div>

        <a className="auth-submit" href="/auth/login/start">
          <span>Continue with Authentik</span>
          <span aria-hidden="true">→</span>
        </a>

        <p className="auth-security">
          <span className="auth-security-dot" aria-hidden="true" />
          Only your approved account can access this archive.
        </p>
        <a className="auth-back" href="/">
          Back to home
        </a>
      </div>
    </main>
  );
}
