"use client";

import { useEffect, useState } from "react";
import { ConversationList } from "../components/conversation-list";
import { MessageTimeline } from "../components/message-timeline";

export default function Home() {
  const [conversationId, setConversationId] = useState<string | undefined>();

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("conversation");
    setConversationId(value || undefined);
  }, []);

  return (
    <main className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="EchoHoard home">
          EchoHoard
        </a>
        <p className="privacy-note">Private archive</p>
      </header>
      <div className="shell-body">
        <nav className="primary-nav" aria-label="Primary navigation">
          <a className="nav-item active" href="/" aria-current="page">
            <span aria-hidden="true">⌂</span>Overview
          </a>
          <a className="nav-item" href="/" aria-current="false">
            <span aria-hidden="true">▤</span>Chats
          </a>
          <a className="nav-item" href="/">
            <span aria-hidden="true">♙</span>People
          </a>
          <a className="nav-item" href="/">
            <span aria-hidden="true">⌕</span>Search
          </a>
          <a className="nav-item secondary" href="/">
            <span aria-hidden="true">⚙</span>Settings
          </a>
        </nav>
        <div className="content-grid" id="main-content">
          <aside className="list-pane" aria-label="Conversation navigation">
            <ConversationList />
          </aside>
          {conversationId ? (
            <MessageTimeline conversationId={conversationId} />
          ) : (
            <section className="welcome-pane" aria-labelledby="welcome-heading">
              <p className="eyebrow">Your archive</p>
              <h1 id="welcome-heading">A calm place for your conversations.</h1>
              <p>Choose a conversation to browse its preserved history.</p>
            </section>
          )}
        </div>
      </div>
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <a className="nav-item active" href="/" aria-current="page">
          <span aria-hidden="true">⌂</span>Overview
        </a>
        <a className="nav-item" href="/">
          <span aria-hidden="true">▤</span>Chats
        </a>
        <a className="nav-item" href="/">
          <span aria-hidden="true">♙</span>People
        </a>
        <a className="nav-item" href="/">
          <span aria-hidden="true">⌕</span>Search
        </a>
      </nav>
    </main>
  );
}
