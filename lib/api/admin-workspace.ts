import { randomUUID } from "node:crypto";
import { z } from "zod";
import { cancelReservation } from "@/lib/booking/cancel";
import { runTurn } from "@/lib/chat/turn";
import { turnLimiter } from "@/lib/chat/ratelimit";
import { createLimiter } from "@/lib/http/ratelimit";
import { errorResponse, okResponse, readJson } from "@/lib/http/json";
import { reservationJson } from "@/lib/api/serialize";
import { refresherOf, type ApiDeps } from "@/lib/api/deps";
import { AdminError, logChange } from "@/lib/admin/common";
import { bookingDetail, listBookings } from "@/lib/admin/bookings";
import { listBranches, updateBranch, updateRestaurant } from "@/lib/admin/branches";
import { addTable, blockSlots, dayView, deleteSpecialDate, listTables, setSpecialDate, setWeeklyHours, specialDates, unblockSlots, upcomingBlocks, updateTable, weeklyHours, RULES_VIEW } from "@/lib/admin/availability";
import { createFaq, faqDetail, listFaqs, updateFaq } from "@/lib/admin/faq";
import { createArticle, createUpload, currentDigest, deleteDocument, documentDetail, knowledgeOverview, previewRetrieval, reingestDocument, replaceUpload, updateDocument } from "@/lib/admin/knowledge";
import { createMenuItem, listMenu, menuItemDetail, updateMenuItem } from "@/lib/admin/menu";
import { overview } from "@/lib/admin/overview";
import { DOC_LIMITS } from "@/lib/kb/documents";
import { loadFactSource, renderKbFacts, renderStaticFacts } from "@/lib/kb/facts";
import { requestWarm } from "@/lib/llm/warm-signal";
import { immediate } from "@/lib/db/tx";

// The staff workspace API (D-25). Every route is under /api/admin, so proxy.ts already requires a loopback Host and,
// for anything but GET, the app's own Origin (D-16, D-22). Handlers validate with zod in lib/admin/*, answer with the
// §5.9 error envelope, and never log request bodies. After an edit that changes what the chatbot retrieves, the index
// refresher re-embeds in the background; after one that changes its system prompt, the warmer re-plants the prefix.

type Ctx<P> = { params: Promise<P> };
type Handler<P> = (req: Request, ctx?: Ctx<P>) => Promise<Response>;

/** Run a handler body; AdminError → its envelope; anything else → a 500 that says the state is unknown. */
function handle<P = Record<string, never>>(fn: (req: Request, params: P) => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown }): Handler<P> {
  return async (req, ctx) => {
    try {
      const params = ctx?.params ? await ctx.params : ({} as P);
      const r = await fn(req, params);
      return okResponse(r.status ?? 200, r.body);
    } catch (e) {
      if (e instanceof AdminError) return errorResponse(e.status, e.code, e.message, e.extra);
      // A database behind the code (a migration not applied yet): say how to fix it, not "something went wrong" (the
      // knowledge page failed this way on a local copy whose database lacked a new column). Nothing was written.
      const behind = e instanceof Error && e.name === "SqliteError" && /no such (?:column|table)/.test(e.message);
      console.error(JSON.stringify({ event: "admin_error", path: new URL(req.url).pathname, method: req.method, error: behind ? "schema_behind" : e instanceof Error ? e.name : "unknown" }));
      if (behind) return errorResponse(503, "UNAVAILABLE", "The database needs updating for this version of the app. Run npm run db:migrate, then reload. Nothing was saved.");
      return errorResponse(500, "INTERNAL", "Something went wrong. Reload the page to see what was saved.");
    }
  };
}

async function body(req: Request, maxBytes?: number): Promise<unknown> {
  const r = await readJson(req, maxBytes);
  if (!r.ok) {
    const j = (await r.response.json()) as { error: { code: "BAD_REQUEST"; message: string } };
    throw new AdminError(r.response.status, j.error.code, j.error.message);
  }
  return r.value;
}

const query = (req: Request) => Object.fromEntries(new URL(req.url).searchParams);
const digestOf = (deps: ApiDeps) => currentDigest(deps.chat.embedder());
const modelName = (deps: ApiDeps) => deps.chat.embedder()?.model ?? null;

/** Kick the background embedding after a change to retrievable facts. */
const refresh = (deps: ApiDeps, trigger: string) => refresherOf(deps).request(trigger);

// ---------- overview ----------

export const overviewHandler = (deps: ApiDeps) => handle(async () => ({ body: overview(deps.db(), deps.now(), await digestOf(deps), modelName(deps)) }));

// ---------- menu ----------

export const menuHandlers = (deps: ApiDeps) => ({
  GET: handle(() => ({ body: listMenu(deps.db()) })),
  POST: handle(async (req) => {
    const item = createMenuItem(deps.db(), deps.now(), await body(req));
    return { status: 201, body: { item, index: { jobId: refresh(deps, "menu") } } };
  }),
});

export const menuItemHandlers = (deps: ApiDeps) => ({
  GET: handle<{ slug: string }>((_req, p) => ({ body: menuItemDetail(deps.db(), p.slug) })),
  PATCH: handle<{ slug: string }>(async (req, p) => {
    const r = updateMenuItem(deps.db(), deps.now(), p.slug, await body(req));
    return { body: { ...r, index: r.changed ? { jobId: refresh(deps, "menu") } : null } };
  }),
});

// ---------- FAQs ----------

export const faqHandlers = (deps: ApiDeps) => ({
  GET: handle(() => ({ body: listFaqs(deps.db()) })),
  POST: handle(async (req) => {
    const faq = createFaq(deps.db(), deps.now(), await body(req));
    return { status: 201, body: { faq, index: { jobId: refresh(deps, "faq") } } };
  }),
});

export const faqItemHandlers = (deps: ApiDeps) => ({
  GET: handle<{ slug: string }>((_req, p) => ({ body: faqDetail(deps.db(), p.slug) })),
  PATCH: handle<{ slug: string }>(async (req, p) => {
    const r = updateFaq(deps.db(), deps.now(), p.slug, await body(req));
    return { body: { ...r, index: r.changed ? { jobId: refresh(deps, "faq") } : null } };
  }),
});

// ---------- knowledge ----------

const KB_JSON_MAX = 512 * 1024;
const UPLOAD_REQUEST_MAX = DOC_LIMITS.maxBytes + 64 * 1024;

async function readUpload(req: Request): Promise<{ file: { name: string; bytes: Uint8Array }; fields: Record<string, string> }> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > UPLOAD_REQUEST_MAX) throw new AdminError(413, "VALIDATION", `The file is too large; the limit is ${DOC_LIMITS.maxBytes / 1024} KB.`, { fields: { file: "too large" } });
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AdminError(400, "BAD_REQUEST", "Expected a file upload (multipart/form-data).");
  }
  const f = form.get("file");
  if (!f || typeof f === "string") throw new AdminError(400, "VALIDATION", "Choose a file to upload.", { fields: { file: "Choose a file" } });
  if (f.size > DOC_LIMITS.maxBytes) throw new AdminError(413, "VALIDATION", `The file is ${Math.ceil(f.size / 1024)} KB; the limit is ${DOC_LIMITS.maxBytes / 1024} KB.`, { fields: { file: "too large" } });
  const fields: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") fields[k] = v;
  return { file: { name: f.name || "upload", bytes: new Uint8Array(await f.arrayBuffer()) }, fields };
}

const isMultipart = (req: Request) => /^multipart\/form-data\b/i.test(req.headers.get("content-type") ?? "");

export const knowledgeHandlers = (deps: ApiDeps) => ({
  GET: handle(async () => ({ body: knowledgeOverview(deps.db(), deps.now(), await digestOf(deps), modelName(deps)) })),
  /** A typed article (JSON) or an uploaded file (multipart: file, title?, docType, branch). */
  POST: handle(async (req) => {
    let r;
    if (isMultipart(req)) {
      const { file, fields } = await readUpload(req);
      r = createUpload(deps.db(), deps.now(), file, { docType: fields.docType, branch: fields.branch ? fields.branch : null, ...(fields.title?.trim() ? { title: fields.title } : {}) });
    } else r = createArticle(deps.db(), deps.now(), await body(req, KB_JSON_MAX));
    return { status: 201, body: { ...r, index: r.ok ? { jobId: refresh(deps, "document") } : null } };
  }),
});

const Id = z.coerce.number().int().positive();
const idOf = (p: { id: string }) => {
  const r = Id.safeParse(p.id);
  if (!r.success) throw new AdminError(404, "NOT_FOUND", "Document not found.");
  return r.data;
};

export const documentHandlers = (deps: ApiDeps) => ({
  GET: handle<{ id: string }>(async (_req, p) => ({ body: documentDetail(deps.db(), idOf(p), await digestOf(deps)) })),
  PATCH: handle<{ id: string }>(async (req, p) => {
    const r = updateDocument(deps.db(), deps.now(), idOf(p), await body(req, KB_JSON_MAX));
    return { body: { ...r, index: r.changed ? { jobId: refresh(deps, "document") } : null } };
  }),
  DELETE: handle<{ id: string }>((_req, p) => {
    const r = deleteDocument(deps.db(), deps.now(), idOf(p));
    return { body: { deleted: true, title: r.title, index: { jobId: refresh(deps, "document deleted") } } };
  }),
});

export const documentFileHandler = (deps: ApiDeps) =>
  handle<{ id: string }>(async (req, p) => {
    const { file } = await readUpload(req);
    const r = replaceUpload(deps.db(), deps.now(), idOf(p), file);
    return { body: { ...r, index: r.ok ? { jobId: refresh(deps, "document") } : null } };
  });

export const documentReingestHandler = (deps: ApiDeps) =>
  handle<{ id: string }>((_req, p) => {
    const r = reingestDocument(deps.db(), deps.now(), idOf(p));
    return { body: { ...r, index: r.ok ? { jobId: refresh(deps, "retry") } : null } };
  });

/** Refresh the index now: retries embedding for everything without a current vector. */
export const refreshHandler = (deps: ApiDeps) => handle(() => ({ status: 202, body: { jobId: refresh(deps, "manual") } }));

const PreviewSchema = z.strictObject({ query: z.string().transform((s) => s.trim()).pipe(z.string().min(2, "Type a question to test").max(300, "Questions can be up to 300 characters")) });

export const previewHandler = (deps: ApiDeps) =>
  handle(async (req) => {
    const r = PreviewSchema.safeParse(await body(req));
    if (!r.success) throw new AdminError(400, "VALIDATION", r.error.issues[0].message, { fields: { query: r.error.issues[0].message } });
    return { body: await previewRetrieval(deps.db(), deps.chat.embedder(), r.data.query) };
  });

// ---------- "how does the chatbot answer this?" ----------

const TestSchema = z.strictObject({ question: z.string().transform((s) => s.trim()).pipe(z.string().min(2, "Type a question to test").max(300, "Questions can be up to 300 characters")) });

/**
 * One real chat turn for a staff test question: a fresh session, the configured model, the guest model gate (so it
 * waits behind guests rather than running beside them), and its own limit so staff tests never use up guests' turns.
 * Nothing is booked: a booking only happens through POST /api/reservations, which this never calls.
 */
export function chatTestHandler(deps: ApiDeps) {
  const limiter = turnLimiter(createLimiter({ limit: 12, windowMs: 60_000 }), createLimiter({ limit: 12, windowMs: 60_000 }), "admin-test");
  return handle(async (req) => {
    const r = TestSchema.safeParse(await body(req));
    if (!r.success) throw new AdminError(400, "VALIDATION", r.error.issues[0].message, { fields: { question: r.error.issues[0].message } });
    const now = deps.now();
    const turn = await runTurn(
      { now, sessionId: `admin-test-${randomUUID()}`, messages: [{ role: "guest", content: r.data.question }], draft: null },
      { db: deps.db(), model: deps.chat.model(), embedder: deps.chat.embedder(), limiter, gate: deps.chat.gate, modelLoaded: deps.chat.modelLoaded },
    );
    if (turn.status === "rate_limited") throw new AdminError(429, "RATE_LIMITED", "Too many test questions in a minute. Wait a moment and try again.");
    const src = loadFactSource(deps.db());
    const facts = new Map([...renderStaticFacts(src, now), ...renderKbFacts(src)].map((f) => [f.id, f.text]));
    return {
      body: {
        question: r.data.question,
        text: turn.reply.text,
        blocks: turn.reply.blocks.map((b) => b.type),
        intent: turn.intent,
        outcome: turn.meta.outcome,
        retrievalMode: turn.meta.retrievalMode,
        model: turn.meta.model,
        latencyMs: turn.meta.latencyMs,
        cited: turn.meta.citedFactIds.map((id) => ({ id, text: facts.get(id) ?? null })),
      },
    };
  });
}

// ---------- availability ----------

const DayQuery = z.object({ branch: z.string().min(1).max(64), date: z.string().min(1).max(10), party: z.coerce.number().int().optional() });

export const availabilityDayHandler = (deps: ApiDeps) =>
  handle((req) => {
    const q = DayQuery.safeParse(query(req));
    if (!q.success) throw new AdminError(400, "VALIDATION", "Choose a branch and a date.", { fields: Object.fromEntries(q.error.issues.map((i) => [String(i.path[0]), i.message])) });
    return { body: dayView(deps.db(), deps.now(), q.data.branch, q.data.date, q.data.party ?? 2) };
  });

/** Everything configurable for one branch: weekly hours, special dates, upcoming blocks, tables and the fixed rules. */
export const branchAvailabilityHandler = (deps: ApiDeps) =>
  handle<{ slug: string }>((_req, p) => ({
    body: { weekly: weeklyHours(deps.db(), p.slug), specialDates: specialDates(deps.db(), deps.now(), p.slug), blocks: upcomingBlocks(deps.db(), deps.now(), p.slug), tables: listTables(deps.db(), deps.now(), p.slug), rules: RULES_VIEW },
  }));

export const weeklyHoursHandler = (deps: ApiDeps) =>
  handle<{ slug: string }>(async (req, p) => {
    const r = setWeeklyHours(deps.db(), deps.now(), p.slug, await body(req));
    if (r.summary !== "no change") requestWarm();
    return { body: r };
  });

export const specialDateHandlers = (deps: ApiDeps) => ({
  PUT: handle<{ slug: string; date: string }>(async (req, p) => {
    const r = setSpecialDate(deps.db(), deps.now(), p.slug, p.date, await body(req));
    requestWarm();
    return { body: r };
  }),
  DELETE: handle<{ slug: string; date: string }>((req, p) => {
    const r = deleteSpecialDate(deps.db(), deps.now(), p.slug, p.date, new URL(req.url).searchParams.get("confirm") === "1");
    requestWarm();
    return { body: r };
  }),
});

export const blockHandlers = (deps: ApiDeps) => ({
  POST: handle<{ slug: string; date: string }>(async (req, p) => ({ body: blockSlots(deps.db(), deps.now(), p.slug, p.date, await body(req)) })),
  DELETE: handle<{ slug: string; date: string }>(async (req, p) => ({ body: unblockSlots(deps.db(), deps.now(), p.slug, p.date, await body(req)) })),
});

export const tableHandlers = (deps: ApiDeps) => ({
  POST: handle<{ slug: string }>(async (req, p) => ({ status: 201, body: { table: addTable(deps.db(), deps.now(), p.slug, await body(req)) } })),
});

export const tableItemHandlers = (deps: ApiDeps) => ({
  PATCH: handle<{ slug: string; id: string }>(async (req, p) => {
    const id = Id.safeParse(p.id);
    if (!id.success) throw new AdminError(404, "NOT_FOUND", "Table not found.");
    return { body: updateTable(deps.db(), deps.now(), p.slug, id.data, await body(req)) };
  }),
});

// ---------- branches ----------

export const branchesHandler = (deps: ApiDeps) => handle(() => ({ body: listBranches(deps.db(), deps.now()) }));

export const branchItemHandler = (deps: ApiDeps) =>
  handle<{ slug: string }>(async (req, p) => {
    const r = updateBranch(deps.db(), deps.now(), p.slug, await body(req));
    if (r.changed) {
      refresh(deps, "branch");
      requestWarm();
    }
    return { body: r };
  });

export const restaurantHandler = (deps: ApiDeps) =>
  handle(async (req) => {
    const r = updateRestaurant(deps.db(), deps.now(), await body(req));
    if (r.changed) {
      refresh(deps, "restaurant");
      requestWarm();
    }
    return { body: r };
  });

// ---------- bookings ----------

export const bookingsListHandler = (deps: ApiDeps) => handle((req) => ({ body: listBookings(deps.db(), deps.now(), query(req)) }));

export const bookingItemHandlers = (deps: ApiDeps) => ({
  GET: handle<{ ref: string }>((_req, p) => ({ body: bookingDetail(deps.db(), p.ref) })),
  /** PATCH {status:'cancelled'}: idempotent staff cancel (BR-13); `changed` false means it was already cancelled. */
  PATCH: handle<{ ref: string }>(async (req, p) => {
    const b = await body(req);
    if (!z.object({ status: z.literal("cancelled") }).safeParse(b).success) throw new AdminError(400, "VALIDATION", "Only status 'cancelled' is supported.", { fields: { status: "must be 'cancelled'" } });
    const db = deps.db();
    const r = cancelReservation(db, p.ref, deps.now());
    if ("code" in r) throw new AdminError(404, "NOT_FOUND", r.message);
    if (r.changed) immediate(db, () => logChange(db, deps.now(), { area: "bookings", action: "cancelled", target: p.ref, summary: `Cancelled booking ${p.ref}` }));
    return { body: { reservation: reservationJson(r.reservation), changed: r.changed } };
  }),
});
