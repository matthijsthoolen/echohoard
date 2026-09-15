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
      <section className="settings-card" aria-labelledby="about-heading">
        <h2 id="about-heading">About EchoHoard</h2>
        <p>Private, read-only access to your preserved conversations.</p>
        <p className="settings-version">Current version · v{ECHOHOARD_VERSION}</p>
      </section>
    </section>
  );
}
