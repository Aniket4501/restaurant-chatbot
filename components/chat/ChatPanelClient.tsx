"use client";

import dynamic from "next/dynamic";

// The chat panel restores its conversation from sessionStorage, which only exists in the browser.
export const ChatPanelClient = dynamic(() => import("@/components/chat/ChatPanel").then((m) => m.ChatPanel), {
  ssr: false,
  loading: () => <p className="px-4 py-6 text-muted">Loading…</p>,
});
