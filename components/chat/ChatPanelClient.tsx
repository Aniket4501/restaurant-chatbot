"use client";

import dynamic from "next/dynamic";
import { useState, type ComponentProps } from "react";
import type { ChatPanel } from "@/components/chat/ChatPanel";

// The chat panel restores its conversation from sessionStorage, which only exists in the browser, so it loads on the
// client. Until it mounts, the server-rendered header shows with a loading line, so the first paint is the restaurant,
// not a blank page.
const Inner = dynamic(() => import("@/components/chat/ChatPanel").then((m) => m.ChatPanel), { ssr: false, loading: () => null });

type Props = Omit<ComponentProps<typeof ChatPanel>, "onReady">;

export function ChatPanelClient(props: Props) {
  const [ready, setReady] = useState(false);
  return (
    <>
      {!ready && (
        <div className="flex-1 overflow-y-auto">
          {props.header}
          <p className="px-4 py-5 text-muted">Loading…</p>
        </div>
      )}
      <Inner {...props} onReady={() => setReady(true)} />
    </>
  );
}
