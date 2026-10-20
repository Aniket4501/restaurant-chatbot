import { connection } from "next/server";
import { ChatPanelClient } from "@/components/chat/ChatPanelClient";
import { IdentityPanel } from "@/components/IdentityPanel";
import { getConfig, RULES } from "@/lib/config";
import { getDb } from "@/lib/db/client";
import { loadIdentity } from "@/lib/chat/identity";
import { getNow } from "@/lib/time/now";
import { todayLocal } from "@/lib/time/tz";

// The guest page (§5.10), mobile-first (2026-10-20): on a phone the chat is the whole screen; on a larger screen the
// same phone layout sits in a phone frame. Everything shown comes from the database at request time with the
// server's clock (D-12); the chat panel is a client component.
export default async function Home() {
  await connection();
  const now = getNow();
  const identity = loadIdentity(getDb(), now);
  const scripted = getConfig().llmProvider === "fake";
  return (
    <div className="min-h-dvh bg-ash md:flex md:flex-col md:items-center md:justify-center md:gap-4 md:bg-[radial-gradient(ellipse_at_top,#e7eee3,#f6f2ea_60%)] md:py-6">
      <div className="relative flex h-dvh flex-col overflow-hidden bg-ash md:h-[min(860px,calc(100dvh-5rem))] md:w-[402px] md:rounded-[56px] md:border-[12px] md:border-[#101a14] md:shadow-[0_40px_90px_-30px_rgba(16,26,20,0.55)]">
        {/* The framed version's status-bar strip with a dynamic island, so nothing scrolls under the island. */}
        <div aria-hidden className="hidden h-11 shrink-0 items-start justify-center bg-smoke pt-2.5 md:flex">
          <span className="h-7 w-28 rounded-full bg-[#101a14]" />
        </div>
        <main className="flex min-h-0 flex-1 flex-col">
          <ChatPanelClient
            branches={identity.branches.map(({ slug, name, short, phoneLabel }) => ({ slug, name, short, phoneLabel }))}
            branchCards={identity.branches.map((b) => ({ slug: b.slug, short: b.short, address: b.address, status: b.status }))}
            restaurantName={identity.name}
            scripted={scripted}
            today={todayLocal(now, RULES.timezone)}
            horizonDays={RULES.horizonDays}
            header={<IdentityPanel identity={identity} />}
          />
        </main>
      </div>
      <p className="hidden text-[14px] text-muted md:block">
        The guest chat, shown at phone size.{" "}
        <a href="/admin" className="text-neem underline underline-offset-4">
          Open the staff bookings page
        </a>
      </p>
    </div>
  );
}
