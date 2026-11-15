// Private file storage for agents (and any caller with a member session).
// POST /functions/v1/files with headers `apikey: <SUPABASE_KEY>` and `x-potluck-key: <agent key>`
// (or `Authorization: Bearer <session token>`), and a JSON body {action, ...}:
//
//   {action: "upload", path, base64, contentType?}  store a file (up to ~6 MB inline) -> {path}
//   {action: "upload_url", path}                    signed upload link for any size up to 50 MB ->
//                                                   {path, url}; then PUT the raw bytes to url
//   {action: "urls", paths: [...]}                  signed links (valid 24 h) -> {links: {path: url}}
//   {action: "list", folder?}                       files in a folder (default: your own) -> {files: [...]}
//   {action: "remove", paths: [...]}                delete your own files -> {removed: [...]}
//
// Paths for upload/upload_url are relative to the caller's folder; everything else takes full paths
// (`will/taiwan/101.jpg`). Members read every file; they write and delete only their own.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const URL_ = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(URL_, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const bucket = () => admin.storage.from("files");
const LINK_SECONDS = 24 * 3600;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "apikey, authorization, content-type, x-potluck-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

class Refusal extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function cleanPath(p: unknown): string {
  const path = String(p ?? "").replace(/^\/+/, "");
  if (!path || path.length > 500 || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Refusal(`Invalid file path "${p}"`);
  }
  return path;
}

// Who is calling: ask the database, forwarding the caller's own credentials (agent key or session).
async function member(req: Request): Promise<string> {
  const headers: Record<string, string> = { apikey: ANON, "Content-Type": "application/json" };
  const key = req.headers.get("x-potluck-key");
  const auth = req.headers.get("authorization");
  if (key) headers["x-potluck-key"] = key;
  else if (auth && auth !== `Bearer ${ANON}`) headers["Authorization"] = auth;
  else throw new Refusal("Send your agent key in the x-potluck-key header", 401);
  const res = await fetch(`${URL_}/rest/v1/rpc/describe`, { method: "POST", headers, body: "{}" });
  const me = res.ok ? (await res.json())?.me : null;
  if (!me) throw new Refusal("Unknown or revoked key, or not a member", 401);
  return me;
}

async function handle(req: Request): Promise<unknown> {
  const me = await member(req);
  const body = await req.json().catch(() => { throw new Refusal("Body must be JSON"); });
  switch (body.action) {
    case "upload": {
      const path = `${me}/${cleanPath(body.path)}`;
      if (typeof body.base64 !== "string") throw new Refusal("base64 is required");
      const bytes = Uint8Array.from(atob(body.base64), (c) => c.charCodeAt(0));
      const { error } = await bucket().upload(path, bytes, { upsert: true, contentType: body.contentType || "application/octet-stream" });
      if (error) throw new Refusal(error.message);
      return { path };
    }
    case "upload_url": {
      const path = `${me}/${cleanPath(body.path)}`;
      const { data, error } = await bucket().createSignedUploadUrl(path, { upsert: true });
      if (error) throw new Refusal(error.message);
      return { path, url: data.signedUrl };
    }
    case "urls": {
      const paths = [...new Set(((body.paths || []) as unknown[]).map(cleanPath))].slice(0, 500);
      if (!paths.length) return { links: {} };
      const { data, error } = await bucket().createSignedUrls(paths, LINK_SECONDS);
      if (error) throw new Refusal(error.message);
      return { links: Object.fromEntries(data.filter((d) => d.signedUrl).map((d) => [d.path, d.signedUrl])) };
    }
    case "list": {
      const folder = body.folder ? cleanPath(body.folder) : me;
      const { data, error } = await bucket().list(folder, { limit: 1000, sortBy: { column: "name", order: "asc" } });
      if (error) throw new Refusal(error.message);
      return {
        files: data.filter((f) => f.id).map((f) => ({
          path: `${folder}/${f.name}`, size: f.metadata?.size ?? null, type: f.metadata?.mimetype ?? null, updated_at: f.updated_at,
        })),
      };
    }
    case "remove": {
      const paths = ((body.paths || []) as unknown[]).map(cleanPath);
      const others = paths.filter((p) => !p.startsWith(`${me}/`));
      if (others.length) throw new Refusal(`You can only remove your own files (not ${others[0]})`, 403);
      if (!paths.length) return { removed: [] };
      const { error } = await bucket().remove(paths);
      if (error) throw new Refusal(error.message);
      return { removed: paths };
    }
    default:
      throw new Refusal('Unknown action; use "upload", "upload_url", "urls", "list" or "remove"');
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Use POST" }, 405);
  try {
    return reply(await handle(req));
  } catch (err) {
    const status = err instanceof Refusal ? err.status : 500;
    return reply({ error: err instanceof Error ? err.message : String(err) }, status);
  }
});
