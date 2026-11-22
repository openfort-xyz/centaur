import type { Ctx, RequestInit } from "../centaur";
import { query, type Params } from "../_lib/http";
import { downloadTo, multipart, outputPath, requireFiles, safeFilename, type SavedFile } from "../_lib/files";

// Results are the Centaur API's Google Chat payloads, passed through: Google Chat's own resources
// (`spaces/…`, `spaces/…/messages/…`) plus `next_page_token` for paging. The API checks the
// caller's per-space grants on every call; a missing grant is HTTP 403.

const DEFAULT_CENTAUR_API = "http://api:8000";
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

type Body = Record<string, any>;

/** A Google Chat message as the API returns it; Google sends more fields. */
export interface Message {
  name: string;
  text?: string;
  createTime?: string;
  sender?: { name?: string; displayName?: string; type?: string };
  thread?: { name?: string };
  attachment?: Body[];
  [field: string]: unknown;
}

/** A message flattened for scans (`search_messages`, `questions`, `dump`). */
export interface ScannedMessage {
  user: string;
  user_id: string;
  text: string;
  timestamp: string;
  permalink: string;
  channel_id: string;
  thread_ts: string | null;
  reply_count: number;
  reactions: Body[];
  type: "message";
  subtype: null;
  replies?: ScannedMessage[];
  replies_has_more?: boolean;
}

/** A bounded scan of a space's history, newest first. */
export interface Scan<T> {
  messages: T[];
  pages_scanned: number;
  /** More pages exist; continue with `next_page_token` or a higher `max_pages`. */
  truncated: boolean;
  next_page_token: string | null;
}

/** A Google Chat attachment downloaded to the sandbox, with the API's metadata for it. */
export interface DownloadedFile extends SavedFile {
  file: Body;
}

interface ScanArgs {
  /** Space resource name, `spaces/AAAA`. */
  space: string;
  /** Messages per page, 1 to 1000; default 100. */
  page_size?: number;
  /** Pages to read at most; default 5. */
  max_pages?: number;
}

function base(ctx: Ctx): string {
  return (ctx.env.CENTAUR_API_URL || DEFAULT_CENTAUR_API).replace(/\/+$/, "");
}

function headers(ctx: Ctx): Record<string, string> {
  const result: Record<string, string> = { accept: "application/json" };
  // Behind iron-proxy the principal's API credential is injected for the API host.
  if (ctx.env.CENTAUR_API_BEARER_TOKEN) result.authorization = `Bearer ${ctx.env.CENTAUR_API_BEARER_TOKEN}`;
  return result;
}

async function api(
  ctx: Ctx,
  path: string,
  options: { method?: string; params?: Params; json?: unknown } = {},
): Promise<Body> {
  const init: RequestInit = { method: options.method ?? "GET", headers: headers(ctx) };
  if (options.json !== undefined) {
    init.headers = { ...headers(ctx), "content-type": "application/json" };
    init.body = JSON.stringify(options.json);
  }
  const res = await ctx.fetch(`${base(ctx)}${path}${query(options.params ?? {})}`, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`Centaur API ${path} returned HTTP ${res.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : {};
}

const seg = (value: string): string => encodeURIComponent(value);

function parse(value: string, pattern: RegExp, example: string): string[] {
  const match = pattern.exec(value.trim());
  if (!match) throw new Error(`${JSON.stringify(value)} is not a resource like ${example}`);
  return match.slice(1).map(seg);
}

/** `/spaces/<id>` from `spaces/AAAA` or `AAAA`. */
function spacePath(space: string): string {
  const id = space.trim().replace(/^spaces\//, "");
  if (!id || id.includes("/")) throw new Error(`${JSON.stringify(space)} is not a resource like spaces/AAAA`);
  return `/api/google-chat/spaces/${seg(id)}`;
}

function messagePath(message: string): string {
  const [space, id] = parse(message, /^spaces\/([^/]+)\/messages\/([^/]+)$/, "spaces/AAAA/messages/BBBB");
  return `/api/google-chat/spaces/${space}/messages/${id}`;
}

function attachmentPath(attachment: string): string {
  const [space, message, id] = parse(
    attachment,
    /^spaces\/([^/]+)\/messages\/([^/]+)\/attachments\/([^/]+)$/,
    "spaces/AAAA/messages/BBBB/attachments/CCCC",
  );
  return `/api/google-chat/spaces/${space}/messages/${message}/attachments/${id}`;
}

function target(email: string): string {
  const value = email.trim().toLowerCase();
  if (!/^[^\s/@]+@[^\s/@]+$/.test(value)) throw new Error(`target ${JSON.stringify(email)} must be an email address`);
  return value;
}

const pageToken = (page: Body): string | null => page.next_page_token || page.nextPageToken || null;

/** Content type for an upload, from the file name's extension; Chat uses it for previews. */
function mimeFor(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
    pdf: "application/pdf", csv: "text/csv", txt: "text/plain", md: "text/markdown",
    json: "application/json", html: "text/html", zip: "application/zip",
    mp4: "video/mp4", mov: "video/quicktime", mp3: "audio/mpeg", wav: "audio/wav",
  };
  return known[extension] ?? "application/octet-stream";
}

/** Follow `next_page_token` for at most `maxPages` pages, collecting `key` from each. */
async function pages(
  maxPages: number,
  fetchPage: (token: string | undefined) => Promise<Body>,
  key: string,
): Promise<{ items: Body[]; pages_scanned: number; next_page_token: string | null }> {
  if (maxPages < 1) throw new Error("max_pages must be at least 1");
  const items: Body[] = [];
  const seen = new Set<string>();
  let token: string | null = null;
  let scanned = 0;
  while (scanned < maxPages) {
    const page = await fetchPage(token ?? undefined);
    scanned += 1;
    items.push(...(page[key] ?? []));
    token = pageToken(page);
    if (!token) break;
    if (seen.has(token)) throw new Error("Google Chat pagination token repeated");
    seen.add(token);
  }
  return { items, pages_scanned: scanned, next_page_token: token };
}

async function scanMessages(ctx: Ctx, args: ScanArgs, filter?: string): Promise<Scan<Message>> {
  const path = `${spacePath(args.space)}/messages`;
  const scan = await pages(
    args.max_pages ?? 5,
    (token) => api(ctx, path, { params: { page_size: args.page_size ?? 100, page_token: token, filter } }),
    "messages",
  );
  const messages = scan.items as Message[];
  const key = (m: Message): string => `${m.createTime ?? ""}\u0000${m.name ?? ""}`;
  messages.sort((a, b) => key(b).localeCompare(key(a)));
  return {
    messages,
    pages_scanned: scan.pages_scanned,
    truncated: Boolean(scan.next_page_token),
    next_page_token: scan.next_page_token,
  };
}

function flatten(space: string, message: Message, reactions?: Map<string, Body[]>): ScannedMessage {
  const name = message.name ?? "";
  const spaceId = space.trim().replace(/^spaces\//, "");
  return {
    user: message.sender?.displayName || message.sender?.name || "",
    user_id: message.sender?.name || "",
    text: message.text || "",
    timestamp: message.createTime || "",
    permalink: `https://mail.google.com/chat/u/0/#chat/space/${spaceId}/${name.split("/").pop() ?? ""}`,
    channel_id: space,
    thread_ts: message.thread?.name || null,
    reply_count: 0,
    reactions: reactions?.get(name) ?? [],
    type: "message",
    subtype: null,
  };
}

/** Spaces this caller is granted. */
export async function spaces(args: { page_size?: number; page_token?: string }, ctx: Ctx): Promise<Body> {
  return api(ctx, "/api/google-chat/spaces", { params: { page_size: args.page_size ?? 20, page_token: args.page_token } });
}

/** One granted space's metadata (`displayName`, `spaceType`, …). */
export async function space_info(args: { space: string }, ctx: Ctx): Promise<Body> {
  return api(ctx, spacePath(args.space));
}

/** Members of a space (`memberships`). */
export async function members(
  args: { space: string; page_size?: number; page_token?: string },
  ctx: Ctx,
): Promise<Body> {
  return api(ctx, `${spacePath(args.space)}/members`, {
    params: { page_size: args.page_size ?? 20, page_token: args.page_token },
  });
}

/**
 * One page of a space's messages. `filter` is Google Chat's message filter (for example
 * `createTime > "2026-01-01T00:00:00Z"` or `thread.name = spaces/AAAA/threads/BBBB`);
 * `order_by` is `createTime ASC` or `createTime DESC`. Follow `next_page_token` as `page_token`.
 */
export async function list_messages(
  args: { space: string; page_size?: number; page_token?: string; filter?: string; order_by?: string },
  ctx: Ctx,
): Promise<Body> {
  return api(ctx, `${spacePath(args.space)}/messages`, {
    params: { page_size: args.page_size ?? 20, page_token: args.page_token, filter: args.filter, order_by: args.order_by },
  });
}

/** One page of a thread's messages; `thread` is `spaces/AAAA/threads/BBBB`. */
export async function thread(
  args: { thread: string; page_size?: number; page_token?: string },
  ctx: Ctx,
): Promise<Body> {
  const [space, id] = parse(args.thread, /^spaces\/([^/]+)\/threads\/([^/]+)$/, "spaces/AAAA/threads/BBBB");
  return api(ctx, `/api/google-chat/spaces/${space}/threads/${id}`, {
    params: { page_size: args.page_size ?? 20, page_token: args.page_token },
  });
}

/** Reactions on one message; `message` is `spaces/AAAA/messages/BBBB`. */
export async function message_reactions(
  args: { message: string; page_size?: number; page_token?: string },
  ctx: Ctx,
): Promise<Body> {
  return api(ctx, `${messagePath(args.message)}/reactions`, {
    params: { page_size: args.page_size ?? 20, page_token: args.page_token },
  });
}

/**
 * Reactions across a bounded scan of a space's recent messages, each tagged with `messageName`.
 * `truncated` when the scan or any message's reactions had more pages. Reacting is not supported.
 */
export async function reactions(
  args: ScanArgs,
  ctx: Ctx,
): Promise<{ reactions: Body[]; pages_scanned: number; truncated: boolean; next_page_token: string | null }> {
  const scan = await scanMessages(ctx, args);
  const found: Body[] = [];
  let incomplete = scan.truncated;
  for (const message of scan.messages) {
    if (typeof message.name !== "string") continue;
    const page = await message_reactions({ message: message.name, page_size: args.page_size ?? 100 }, ctx);
    for (const item of page.reactions ?? []) found.push({ ...item, messageName: message.name });
    incomplete = incomplete || Boolean(pageToken(page));
  }
  return { reactions: found, pages_scanned: scan.pages_scanned, truncated: incomplete, next_page_token: scan.next_page_token };
}

/** Case-insensitive substring search over a bounded scan of a space's history, newest first. */
export async function search_messages(
  args: ScanArgs & { query: string },
  ctx: Ctx,
): Promise<Scan<ScannedMessage> & { query: string }> {
  const scan = await scanMessages(ctx, args);
  const needle = args.query.toLowerCase();
  const messages = scan.messages
    .filter((m) => (m.text ?? "").toLowerCase().includes(needle))
    .map((m) => flatten(args.space, m));
  return { ...scan, query: args.query, messages };
}

const QUESTION_PREFIXES = [
  "how", "why", "what", "when", "where", "who", "which", "can ", "could ", "should ",
  "is there", "does anyone", "has anyone",
];

/** Question-like messages (ending in `?` or starting with how/why/what/…) in a bounded scan. */
export async function questions(
  args: ScanArgs,
  ctx: Ctx,
): Promise<Scan<ScannedMessage> & { space: string; questions: ScannedMessage[] }> {
  const scan = await scanMessages(ctx, args);
  const found = scan.messages
    .filter((m) => {
      const text = (m.text ?? "").trim();
      const lowered = text.toLowerCase();
      return text.length > 10 && (text.endsWith("?") || QUESTION_PREFIXES.some((p) => lowered.startsWith(p)));
    })
    .map((m) => flatten(args.space, m));
  return { ...scan, space: args.space, messages: found, questions: found };
}

/**
 * A bounded dump of a space: recent messages flattened, with reactions, and the replies of up to
 * `max_threads` (default 50) threads expanded. `truncated` when any bound cut the dump short.
 */
export async function dump(args: ScanArgs & { max_threads?: number }, ctx: Ctx): Promise<Body> {
  const maxThreads = args.max_threads ?? 50;
  if (maxThreads < 0) throw new Error("max_threads cannot be negative");
  const space = await space_info({ space: args.space }, ctx);
  const scan = await scanMessages(ctx, args);
  const reacted = await reactions(args, ctx);
  const byMessage = new Map<string, Body[]>();
  for (const reaction of reacted.reactions) {
    const key = String(reaction.messageName ?? "");
    byMessage.set(key, [...(byMessage.get(key) ?? []), reaction]);
  }
  const messages = scan.messages.map((m) => flatten(args.space, m, byMessage));
  const threadNames = [...new Set(scan.messages.map((m) => m.thread?.name).filter((n): n is string => Boolean(n)))];
  for (const threadName of threadNames.slice(0, maxThreads)) {
    const page = await thread({ thread: threadName, page_size: args.page_size ?? 100 }, ctx);
    const replies = ((page.messages ?? []) as Message[]).map((m) => flatten(args.space, m, byMessage));
    for (const message of messages) {
      if (message.thread_ts !== threadName) continue;
      message.replies = replies;
      message.replies_has_more = Boolean(pageToken(page));
    }
  }
  const expanded = Math.min(threadNames.length, maxThreads);
  const incomplete = scan.truncated || reacted.truncated || threadNames.length > maxThreads;
  return {
    channel: space.displayName || space.name || args.space,
    channel_id: args.space,
    messages,
    has_more: scan.truncated,
    next_cursor: scan.next_page_token,
    continuation_available: incomplete,
    truncated: incomplete,
    limits: { message_pages: args.max_pages ?? 5, page_size: args.page_size ?? 100, thread_limit: maxThreads },
    stats: {
      total_messages: messages.length,
      threads_expanded: expanded,
      threads_skipped_by_limit: threadNames.length - expanded,
      total_reactions: reacted.reactions.length,
    },
  };
}

const NEGATIVE = ["wrong", "broken", "doesn't work", "failed", "error", "incorrect", "try again"];
const POSITIVE = ["thanks", "great", "perfect", "worked", "awesome"];

/**
 * Feedback signals in a bounded dump: messages whose text or 👍/👎 reactions read as an `issue`
 * or a `success`.
 */
export async function feedback(args: ScanArgs, ctx: Ctx): Promise<Body> {
  const dumped = await dump(args, ctx);
  const items: Body[] = [];
  for (const message of dumped.messages as ScannedMessage[]) {
    const lowered = message.text.toLowerCase();
    const emoji = new Set(message.reactions.map((r) => String(r.emoji?.unicode ?? "")));
    const category = NEGATIVE.some((w) => lowered.includes(w)) || emoji.has("👎")
      ? "issue"
      : POSITIVE.some((w) => lowered.includes(w)) || emoji.has("👍") ? "success" : null;
    if (!category) continue;
    items.push({
      channel: dumped.channel,
      channel_id: args.space,
      thread_ts: message.thread_ts || message.timestamp,
      permalink: message.permalink,
      category,
      severity: category === "issue" ? "medium" : "low",
      summary: message.text.slice(0, 200),
      evidence: { reactions: message.reactions },
      reporter_user: message.user,
      status: "new",
    });
  }
  return {
    channel: dumped.channel,
    channel_id: args.space,
    items,
    truncated: dumped.truncated,
    continuation_available: dumped.continuation_available,
  };
}

/** One page of attachments posted in a space (`files`); follow `next_page_token`. */
export async function files(
  args: { space: string; page_size?: number; page_token?: string },
  ctx: Ctx,
): Promise<Body> {
  return api(ctx, `${spacePath(args.space)}/files`, {
    params: { page_size: args.page_size ?? 100, page_token: args.page_token },
  });
}

/**
 * Attachments in a bounded scan of a space whose name, content type or ID contains `query`
 * (case-insensitive), newest first.
 */
export async function search_files(
  args: ScanArgs & { query: string },
  ctx: Ctx,
): Promise<{ files: Body[]; query: string; pages_scanned: number; truncated: boolean; next_page_token: string | null }> {
  if (!args.query.trim()) throw new Error("query must not be empty");
  const scan = await pages(
    args.max_pages ?? 5,
    (token) => files({ space: args.space, page_size: args.page_size ?? 100, page_token: token }, ctx),
    "files",
  );
  const needle = args.query.toLowerCase();
  const haystack = (f: Body): string =>
    ["contentName", "filename", "contentType", "attachment_id"].map((k) => String(f[k] ?? "")).join(" ").toLowerCase();
  const key = (f: Body): string => `${f.message_create_time ?? ""}\u0000${f.attachment_id ?? ""}`;
  const matches = scan.items.filter((f) => haystack(f).includes(needle)).sort((a, b) => key(b).localeCompare(key(a)));
  return {
    files: matches,
    query: args.query,
    pages_scanned: scan.pages_scanned,
    truncated: Boolean(scan.next_page_token),
    next_page_token: scan.next_page_token,
  };
}

/** Metadata for one attachment, `spaces/AAAA/messages/BBBB/attachments/CCCC`. */
export async function file_info(args: { attachment: string }, ctx: Ctx): Promise<Body> {
  return api(ctx, attachmentPath(args.attachment));
}

/**
 * Download an attachment (`spaces/AAAA/messages/BBBB/attachments/CCCC`) to the sandbox and return
 * where it landed, plus its metadata. `path` defaults to `downloads/google_chat/<file name>`.
 *
 * @requires files
 */
export async function download_file(args: { attachment: string; path?: string }, ctx: Ctx): Promise<DownloadedFile> {
  requireFiles(ctx, "google_chat.download_file");
  const resource = attachmentPath(args.attachment);
  const info = await api(ctx, resource);
  const name = String(info.contentName || args.attachment.split("/").pop() || "attachment");
  const path = outputPath(args.path, "google_chat", safeFilename(name, "attachment"));
  const saved = await downloadTo(ctx, `${base(ctx)}${resource}/download`, path, `downloading ${args.attachment}`, {
    headers: headers(ctx),
  });
  return { ...saved, file: info };
}

/** Whether the Google Chat API is reachable for this caller, and how many spaces one page shows. */
export async function health(args: {}, ctx: Ctx): Promise<{ reachable: true; via: "api-rs"; spaces: number }> {
  const result = await spaces({ page_size: 1 }, ctx);
  return { reachable: true, via: "api-rs", spaces: (result.spaces ?? []).length };
}

/** Write: post `text` to a space, optionally as a reply in `thread` (`spaces/AAAA/threads/BBBB`). */
export async function send_message(args: { space: string; text: string; thread?: string }, ctx: Ctx): Promise<Message> {
  const json: Body = { text: args.text };
  if (args.thread) json.thread_name = args.thread;
  return (await api(ctx, `${spacePath(args.space)}/messages`, { method: "POST", json })) as Message;
}

/** Write: replace the text of a message (`spaces/AAAA/messages/BBBB`). */
export async function update_message(args: { message: string; text: string }, ctx: Ctx): Promise<Message> {
  return (await api(ctx, messagePath(args.message), { method: "PATCH", json: { text: args.text } })) as Message;
}

/** Write: delete a message (`spaces/AAAA/messages/BBBB`). */
export async function delete_message(args: { message: string }, ctx: Ctx): Promise<Body> {
  return api(ctx, messagePath(args.message), { method: "DELETE" });
}

/** Write: find or create the DM space with a granted user, by email. */
export async function setup_dm(args: { target: string }, ctx: Ctx): Promise<Body> {
  return api(ctx, "/api/google-chat/dms/setup", { method: "POST", params: { target_identity: target(args.target) }, json: {} });
}

/** Write: DM a granted user (by email), creating the DM space if needed. Returns `{ message, … }`. */
export async function send_dm(args: { target: string; text: string }, ctx: Ctx): Promise<Body> {
  return api(ctx, "/api/google-chat/dms/messages", {
    method: "POST",
    params: { target_identity: target(args.target) },
    json: { text: args.text },
  });
}

/**
 * Write: upload a file from the sandbox (`path`) into a space as a new message, optionally with a
 * caption (`text`) and in a thread (`spaces/AAAA/threads/BBBB`). `filename` defaults to the
 * path's last segment; the file is streamed from disk, not read into the cell. At most 100 MiB.
 *
 * @requires files
 */
export async function upload_file(
  args: { space: string; path: string; filename?: string; text?: string; thread?: string },
  ctx: Ctx,
): Promise<Message> {
  const fs = requireFiles(ctx, "google_chat.upload_file");
  if (!(await fs.stat(args.path))) throw new Error(`no such file: ${args.path}`);
  const filename = args.filename ?? args.path.split(/[\\/]/).pop() ?? "file";
  const fields = [
    { name: "text", value: args.text },
    { name: "thread_name", value: args.thread },
  ].filter((field): field is { name: string; value: string } => Boolean(field.value));
  const form = multipart([
    ...fields.map((field) => ({ name: field.name, body: field.value })),
    { name: "file", filename, content_type: mimeFor(filename), body: { file: args.path } },
  ]);
  const path = `${spacePath(args.space)}/attachments`;
  const res = await ctx.fetch(`${base(ctx)}${path}`, {
    method: "POST",
    headers: { ...headers(ctx), "content-type": form.content_type },
    body: form.body,
    timeout_ms: UPLOAD_TIMEOUT_MS,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Centaur API ${path} returned HTTP ${res.status}: ${text.slice(0, 1000)}`);
  return JSON.parse(text) as Message;
}
