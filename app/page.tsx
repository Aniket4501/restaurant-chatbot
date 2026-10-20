import { connection } from "next/server";
import { ChatPanelClient } from "@/components/chat/ChatPanelClient";
import { IdentityPanel } from "@/components/IdentityPanel";
import { getConfig } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { loadIdentity } from "@/lib/chat/identity";
import { getNow } from "@/lib/time/now";

// The guest page (§5.10): looks like the restaurant's own site. Everything shown comes from the database at request
// time with the server's clock (D-12); the chat panel is a client component.
export default async function Home() {
  await connection();
  const identity = loadIdentity(getDb(), getNow());
  const scripted = getConfig().llmProvider === "fake";
  return (
    <div className="flex min-h-dvh flex-col lg:flex-row">
      <IdentityPanel identity={identity} />
      <main className="flex h-dvh min-w-0 flex-1 flex-col lg:h-dvh">
        <ChatPanelClient branches={identity.branches.map(({ slug, name, short, phoneLabel }) => ({ slug, name, short, phoneLabel }))} restaurantName={identity.name} scripted={scripted} />
      </main>
    </div>
  );
}
