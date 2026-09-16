"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { ConversationList } from "../components/conversation-list";
import { MessageTimeline } from "../components/message-timeline";
import { SearchPanel } from "../components/search-panel";
import { ArchiveOverview } from "../components/archive-overview";
import { PeopleList } from "../components/people-list";
import { ECHOHOARD_VERSION } from "../../../application/version";

type ShellView = "overview" | "chats" | "people" | "search" | "settings";

const navigation = [
  ["overview", "⌂", "Overview"],
  ["chats", "▤", "Chats"],
  ["people", "♙", "People"],
  ["search", "⌕", "Search"],
] as const satisfies readonly [ShellView, string, string][];

export default function ArchiveShell() {
  const [view, setView] = useState<ShellView>("overview");
  const [conversationId, setConversationId] = useState<string | undefined>();
  const [messageId, setMessageId] = useState<string | undefined>();
  const [theme, setTheme] = useState<ThemeMode>("system");

  useEffect(() => {
    const syncLocation = () => {
      const params = new URLSearchParams(window.location.search);
      setView(shellView(params.get("view")));
      setConversationId(params.get("conversation") || undefined);
      setMessageId(params.get("message") || undefined);
    };
    syncLocation();
    window.addEventListener("popstate", syncLocation);
    return () => window.removeEventListener("popstate", syncLocation);
  }, []);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("echohoard-theme");
      if (stored === "light" || stored === "dark" || stored === "system") setTheme(stored);
    } catch {
      // A restricted browser storage context should still get the system theme.
    }
  }, []);

  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem("echohoard-theme", theme);
    } catch {
      // Theme selection remains active for this page even if persistence is unavailable.
    }
  }, [theme]);

  const hrefFor = (nextView: ShellView) => (nextView === "overview" ? "/" : `/?view=${nextView}`);
  const showTimeline = Boolean(conversationId) && (view === "chats" || view === "search");

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <h1 className="sr-only">EchoHoard archive viewer</h1>
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="EchoHoard home">
          <Image
            className="wordmark-mark-image"
            src="/brand/echohoard-mark.png"
            alt="EchoHoard"
            width={48}
            height={48}
            priority
          />
          <span className="wordmark-label">EchoHoard</span>
        </a>
      </header>
      <div className="shell-body">
        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map(([item, icon, label]) => (
            <a
              className={`nav-item${view === item ? " active" : ""}`}
              href={hrefFor(item)}
              aria-current={view === item ? "page" : undefined}
              key={item}
            >
              <span aria-hidden="true">{icon}</span>
              {label}
            </a>
          ))}
          <div className="nav-footer">
            <a
              className={`nav-item${view === "settings" ? " active" : ""}`}
              href={hrefFor("settings")}
              aria-current={view === "settings" ? "page" : undefined}
            >
              <span aria-hidden="true">⚙</span>Settings
            </a>
            <p className="app-version">v{ECHOHOARD_VERSION}</p>
          </div>
        </nav>
        {view === "settings" ? (
          <SettingsPanel theme={theme} onThemeChange={setTheme} />
        ) : (
          <div className="content-grid" id="main-content">
            <aside className="list-pane" aria-label="Conversation navigation">
              {view === "overview" ? <SearchPanel /> : null}
              {view === "search" ? <SearchPanel /> : null}
              {view === "people" ? <PeopleList /> : null}
              {view === "overview" || view === "chats" ? <ConversationList /> : null}
            </aside>
            {showTimeline ? (
              <MessageTimeline conversationId={conversationId!} messageId={messageId} />
            ) : view === "overview" ? (
              <ArchiveOverview />
            ) : view === "chats" ? (
              <ShellLanding
                title="Choose a conversation"
                detail="Select a chat from the list to open its preserved timeline."
              />
            ) : view === "people" ? (
              <ShellLanding
                title="People in your archive"
                detail="Use the list to browse observed names and search their archived messages."
              />
            ) : (
              <ShellLanding
                title="Search your archive"
                detail="Use the filters in the left panel to find messages and open their conversation context."
              />
            )}
          </div>
        )}
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        {navigation.map(([item, icon, label]) => (
          <a
            className={`nav-item${view === item ? " active" : ""}`}
            href={hrefFor(item)}
            aria-current={view === item ? "page" : undefined}
            key={item}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
          </a>
        ))}
        <a
          className={`nav-item${view === "settings" ? " active" : ""}`}
          href={hrefFor("settings")}
          aria-current={view === "settings" ? "page" : undefined}
        >
          <span aria-hidden="true">⚙</span>Settings
        </a>
        <p className="app-version">v{ECHOHOARD_VERSION}</p>
      </nav>
    </main>
  );
}

type ThemeMode = "light" | "dark" | "system";

function shellView(value: string | null): ShellView {
  return value === "chats" || value === "people" || value === "search" || value === "settings"
    ? value
    : "overview";
}

function ShellLanding({ title, detail }: { readonly title: string; readonly detail: string }) {
  return (
    <section className="shell-landing" aria-labelledby="shell-landing-title">
      <span className="shell-landing-icon" aria-hidden="true">
        ✦
      </span>
      <h1 id="shell-landing-title">{title}</h1>
      <p>{detail}</p>
    </section>
  );
}

function SettingsPanel({
  theme,
  onThemeChange,
}: {
  readonly theme: ThemeMode;
  readonly onThemeChange: (theme: ThemeMode) => void;
}) {
  const [catalog, setCatalog] = useState<TranscriptionSettings | "loading" | "error">("loading");
  const [accounts, setAccounts] = useState<OwnedAccountSettings[] | "loading" | "denied" | "error">(
    "loading",
  );
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/admin/transcription-model", { credentials: "same-origin" })
      .then(async (response) => {
        if (!response.ok) throw new Error("settings unavailable");
        return (await response.json()) as TranscriptionSettings;
      })
      .then(setCatalog, () => setCatalog("error"));
  }, []);

  useEffect(() => {
    void fetch("/api/admin/accounts", { credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 403) return "denied" as const;
        if (!response.ok) throw new Error("accounts unavailable");
        const body = (await response.json()) as { readonly accounts: OwnedAccountSettings[] };
        return body.accounts;
      })
      .then(setAccounts, () => setAccounts("error"));
  }, []);

  const selectModel = async (modelId: string) => {
    if (catalog === "loading" || catalog === "error") return;
    setSaving(true);
    try {
      const response = await fetch("/api/admin/transcription-model", {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ modelId: modelId || null }),
      });
      if (!response.ok) throw new Error("selection unavailable");
      setCatalog((await response.json()) as TranscriptionSettings);
    } catch {
      // The prior selection remains visible; the next render can retry discovery.
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-panel" id="main-content" aria-labelledby="settings-heading">
      <p className="eyebrow">Preferences</p>
      <h1 id="settings-heading">Settings</h1>
      <p className="settings-intro">Personalize this browser without changing your archive.</p>
      <section className="settings-card" aria-labelledby="appearance-heading">
        <h2 id="appearance-heading">Appearance</h2>
        <p>Choose light, dark, or follow your device preference.</p>
        <div className="theme-options" role="group" aria-label="Color theme">
          {(["system", "light", "dark"] as const).map((option) => (
            <button
              className={`button${theme === option ? " button-primary" : ""}`}
              type="button"
              aria-pressed={theme === option}
              onClick={() => onThemeChange(option)}
              key={option}
            >
              {option[0].toUpperCase() + option.slice(1)}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-card" aria-labelledby="transcription-heading">
        <h2 id="transcription-heading">Transcription model</h2>
        <p>Choose the allowlisted model for future voice and video-note transcription.</p>
        {catalog === "loading" ? <p role="status">Loading available models…</p> : null}
        {catalog === "error" ? (
          <p role="alert">Transcription models are temporarily unavailable.</p>
        ) : null}
        {catalog !== "loading" && catalog !== "error" ? (
          <>
            <label htmlFor="transcription-model">Allowed model</label>
            <select
              id="transcription-model"
              value={catalog.selectedModel ?? ""}
              disabled={saving || catalog.discovery === "error" || catalog.models.length === 0}
              onChange={(event) => void selectModel(event.target.value)}
            >
              <option value="">No model selected</option>
              {catalog.models.map((model) => (
                <option value={model.id} key={model.id}>
                  {model.label}
                </option>
              ))}
              {catalog.selectedModelState === "unavailable" ? (
                <option value={catalog.selectedModel ?? ""} disabled>
                  Selected model unavailable
                </option>
              ) : null}
            </select>
            {catalog.models.length === 0 ? (
              <p role="status">No allowed transcription model is configured.</p>
            ) : null}
            {catalog.selectedModelState === "unavailable" ? (
              <p role="alert">The saved model is unavailable. New transcription work is blocked.</p>
            ) : null}
          </>
        ) : null}
      </section>
      <LiveAccountsSettings accounts={accounts} onAccountsChange={(next) => setAccounts(next)} />
      <section className="settings-card" aria-labelledby="about-heading">
        <h2 id="about-heading">About EchoHoard</h2>
        <p>Private, read-only access to your preserved conversations.</p>
        <p className="settings-version">Current version · v{ECHOHOARD_VERSION}</p>
      </section>
    </section>
  );
}

function LiveAccountsSettings({
  accounts,
  onAccountsChange,
}: {
  readonly accounts: OwnedAccountSettings[] | "loading" | "denied" | "error";
  readonly onAccountsChange: (accounts: OwnedAccountSettings[]) => void;
}) {
  const [pairing, setPairing] = useState<PairingSession | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!pairing || pairing.state !== "awaiting_qr") return;
    const timer = window.setInterval(() => {
      void fetch(
        `/api/admin/accounts/${encodeURIComponent(pairing.accountId)}/pair?sessionId=${encodeURIComponent(pairing.sessionId)}`,
        { credentials: "same-origin" },
      )
        .then(async (response) => {
          if (!response.ok) throw new Error("pairing status unavailable");
          return (await response.json()) as PairingSession;
        })
        .then(setPairing, () => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [pairing]);

  const reload = async () => {
    const response = await fetch("/api/admin/accounts", { credentials: "same-origin" });
    if (!response.ok) throw new Error("account settings unavailable");
    const body = (await response.json()) as { readonly accounts: OwnedAccountSettings[] };
    onAccountsChange(body.accounts);
  };

  const beginPairing = async (account: OwnedAccountSettings) => {
    const rePair = account.health.connection === "connected";
    if (
      rePair &&
      !window.confirm("Re-pair this account? The current linked session will be replaced.")
    )
      return;
    setMessage(null);
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}/pair`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirm: rePair, rePair }),
      });
      if (!response.ok) throw new Error("pairing unavailable");
      setPairing((await response.json()) as PairingSession);
      await reload();
    } catch {
      setMessage("Pairing is temporarily unavailable. Try again or inspect account health.");
    }
  };

  const changeLiveState = async (account: OwnedAccountSettings, action: "pause" | "resume") => {
    if (action === "pause" && !window.confirm("Pause live capture for this account?")) return;
    try {
      const response = await fetch(`/api/admin/accounts/${encodeURIComponent(account.id)}`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action, confirm: action === "pause" }),
      });
      if (!response.ok) throw new Error("state change unavailable");
      await reload();
    } catch {
      setMessage("The live capture state could not be changed.");
    }
  };

  return (
    <section className="settings-card" aria-labelledby="live-accounts-heading">
      <h2 id="live-accounts-heading">Live accounts</h2>
      <p>
        Administrator-only pairing and read-only capture health. QR codes expire after five minutes.
      </p>
      {accounts === "loading" ? <p role="status">Loading account health…</p> : null}
      {accounts === "denied" ? (
        <p role="status">Administrator access is required for live accounts.</p>
      ) : null}
      {accounts === "error" ? <p role="alert">Account health is temporarily unavailable.</p> : null}
      {Array.isArray(accounts) && accounts.length === 0 ? (
        <p>No owned live accounts are configured.</p>
      ) : null}
      {Array.isArray(accounts) ? (
        <div className="account-list">
          {accounts.map((account) => (
            <article className="account-row" key={account.id}>
              <div>
                <h3>{account.label}</h3>
                <p className="account-state">{account.health.connection}</p>
              </div>
              <div className="account-actions">
                <button type="button" className="button" onClick={() => void beginPairing(account)}>
                  {account.health.connection === "connected" ? "Re-pair" : "Pair"}
                </button>
                {account.liveEnabled ? (
                  <button
                    type="button"
                    className="button"
                    onClick={() => void changeLiveState(account, "pause")}
                  >
                    Pause
                  </button>
                ) : (
                  <button
                    type="button"
                    className="button"
                    onClick={() => void changeLiveState(account, "resume")}
                  >
                    Resume
                  </button>
                )}
              </div>
              <dl className="account-health">
                <div>
                  <dt>Receipts</dt>
                  <dd>
                    {account.health.receipt.state} · {account.health.receipt.count}
                  </dd>
                </div>
                <div>
                  <dt>Normalization</dt>
                  <dd>{account.health.normalization.state}</dd>
                </div>
                <div>
                  <dt>Backup</dt>
                  <dd>{account.health.backupConfirmation.state}</dd>
                </div>
              </dl>
            </article>
          ))}
        </div>
      ) : null}
      {pairing ? (
        <section className="pairing-session" aria-live="polite" aria-labelledby="pairing-heading">
          <h3 id="pairing-heading">Pairing session</h3>
          {pairing.state === "awaiting_qr" && pairing.qr ? <pre>{pairing.qr}</pre> : null}
          <p>
            {pairing.state === "expired"
              ? "This QR code expired. Start a new pairing session."
              : pairing.state}
          </p>
          {pairing.state === "expired" ? (
            <button type="button" className="button" onClick={() => setPairing(null)}>
              Dismiss
            </button>
          ) : null}
        </section>
      ) : null}
      {message ? <p role="alert">{message}</p> : null}
    </section>
  );
}

interface TranscriptionSettings {
  readonly models: readonly { readonly id: string; readonly label: string }[];
  readonly selectedModel: string | null;
  readonly selectedModelState: "selected" | "unset" | "unavailable";
  readonly discovery: "ready" | "error";
}

interface OwnedAccountSettings {
  readonly id: string;
  readonly label: string;
  readonly accountKey: string;
  readonly liveEnabled: boolean;
  readonly health: {
    readonly connection: string;
    readonly receipt: { readonly state: string; readonly count: number };
    readonly normalization: { readonly state: string };
    readonly backupConfirmation: { readonly state: string };
  };
}

interface PairingSession {
  readonly sessionId: string;
  readonly accountId: string;
  readonly state: "awaiting_qr" | "connected" | "expired";
  readonly qr?: string;
}
