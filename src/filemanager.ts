import { InputError, MAX_FILE_BYTES, PicaApi, validatePath } from "./api.ts";

export type FileSession = {
  ownerId: string;
  instanceId: string;
  expires: number;
};

const SESSION_TTL = 3_600_000;

const PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Files</title>
<style>
body{background:#0f1115;color:#d7dce4;font:14px/1.4 system-ui,sans-serif;margin:0;padding:16px;max-width:960px}
a{color:#7aa2f7;text-decoration:none;cursor:pointer}
button{background:#1f2430;color:#d7dce4;border:1px solid #333a4a;border-radius:6px;padding:4px 10px;cursor:pointer}
button:hover{border-color:#7aa2f7}
table{width:100%;border-collapse:collapse;margin-top:12px}
td,th{padding:6px 8px;border-bottom:1px solid #232838;text-align:left}
th{color:#8b93a5;font-weight:600}
.bar{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
#err{display:none;background:#3a1520;border:1px solid #7a2a3a;color:#ffb3c0;padding:8px 10px;border-radius:6px;margin-bottom:10px}
.num{text-align:right;color:#8b93a5}
.rowbtns{white-space:nowrap;text-align:right}
.rowbtns button{margin-left:6px}
</style>
<div id="err"></div>
<div class="bar">
  <button id="up">Up</button>
  <span id="crumbs"></span>
</div>
<div class="bar">
  <button id="upbtn">Upload</button>
  <input id="pick" type="file" hidden>
  <button id="mk">New folder</button>
</div>
<table><thead><tr><th>Name</th><th class="num">Size</th><th>Modified</th><th></th></tr></thead><tbody id="rows"></tbody></table>
<p id="empty" hidden>Empty folder.</p>
<script>
const token = location.pathname.split("/")[2];
const $ = (id) => document.getElementById(id);
const esc = (s) => s.replace(/[&<>"']/g, (c) => "&#" + c.charCodeAt(0) + ";");
const join = (a, b) => (a ? a + "/" + b : b);
const fmt = (n) => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KiB" : (n / 1048576).toFixed(1) + " MiB";
let path = "";
async function api(action, options) {
  const r = await fetch("/f/" + token + "/api/" + action, options);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Request failed.");
  return data;
}
function fail(e) { const el = $("err"); el.textContent = e.message; el.style.display = "block"; }
async function refresh() {
  $("err").style.display = "none";
  try {
    const d = await api("list?path=" + encodeURIComponent(path));
    const parts = path ? path.split("/") : [];
    $("crumbs").innerHTML = '<a data-p="">root</a>' + parts.map((p, i) =>
      " / " + '<a data-p="' + esc(parts.slice(0, i + 1).join("/")) + '">' + esc(p) + "</a>").join("");
    $("rows").innerHTML = d.entries.map((e) => {
      const p = join(path, e.name);
      const dl = "/f/" + token + "/api/download?path=" + encodeURIComponent(p);
      return "<tr><td>" + (e.directory
        ? '<a data-p="' + esc(p) + '">' + esc(e.name) + "/</a>"
        : '<a href="' + dl + '">' + esc(e.name) + "</a>") +
        '</td><td class="num">' + (e.directory ? "" : fmt(e.size)) +
        '</td><td>' + esc(new Date(e.modified).toLocaleString()) +
        '</td><td class="rowbtns">' +
        (e.directory ? "" : '<a href="' + dl + '"><button>Download</button></a>') +
        '<button data-k="ren" data-p="' + esc(p) + '">Rename</button>' +
        '<button data-k="del" data-p="' + esc(p) + '" data-d="' + (e.directory ? 1 : 0) + '">Delete</button>' +
        "</td></tr>";
    }).join("");
    $("empty").hidden = d.entries.length > 0;
  } catch (e) { fail(e); }
}
document.addEventListener("click", async (ev) => {
  const t = ev.target instanceof Element ? ev.target.closest("[data-p]") : null;
  if (!t) return;
  const p = t.dataset.p, k = t.dataset.k;
  try {
    if (!k) { path = p; await refresh(); return; }
    if (k === "ren") {
      const name = prompt("New name", p.split("/").pop());
      if (!name || name.includes("/")) return;
      const parent = p.split("/").slice(0, -1).join("/");
      await api("rename", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, destination: join(parent, name) }) });
    } else if (k === "del") {
      if (!confirm("Delete " + p + "?")) return;
      await api("delete", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: p, recursive: t.dataset.d === "1" }) });
    }
    await refresh();
  } catch (e) { fail(e); }
});
$("up").addEventListener("click", () => { path = path.split("/").slice(0, -1).join("/"); refresh(); });
$("upbtn").addEventListener("click", () => $("pick").click());
$("pick").addEventListener("change", async () => {
  const f = $("pick").files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append("file", f);
  try {
    await api("upload?path=" + encodeURIComponent(path), { method: "POST", body: fd });
    await refresh();
  } catch (e) { fail(e); }
  $("pick").value = "";
});
$("mk").addEventListener("click", async () => {
  const name = prompt("Folder name");
  if (!name || name.includes("/")) return;
  try {
    await api("mkdir", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: join(path, name) }) });
    await refresh();
  } catch (e) { fail(e); }
});
refresh();
</script>`;

function missing(): Response {
  return new Response(
    "<!doctype html><title>Not found</title><p>This link is invalid or has expired.</p>",
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

export class FileManager {
  readonly sessions = new Map<string, FileSession>();
  constructor(
    private api: PicaApi,
    private baseUrl: string,
    private onUse: (ownerId: string) => void,
    private now = Date.now,
  ) {}

  issue(ownerId: string, instanceId: string): string {
    const token = crypto.randomUUID().replaceAll("-", "");
    this.sessions.set(token, {
      ownerId,
      instanceId,
      expires: this.now() + SESSION_TTL,
    });
    return `${this.baseUrl}/f/${token}`;
  }

  revoke(ownerId: string): void {
    for (const [token, session] of this.sessions) {
      if (session.ownerId === ownerId) this.sessions.delete(token);
    }
  }

  handler(): (req: Request) => Promise<Response> {
    return async (req) => {
      const segments = new URL(req.url).pathname.split("/").filter(Boolean);
      if (segments[0] !== "f" || segments.length < 2) return missing();
      const session = this.sessions.get(segments[1]);
      if (!session || session.expires <= this.now()) return missing();
      session.expires = this.now() + SESSION_TTL;
      this.onUse(session.ownerId);
      const route = segments.slice(2);
      if (route.length === 0) {
        return new Response(PAGE, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      if (route[0] !== "api" || route.length !== 2) return missing();
      try {
        return await this.serve(session, route[1], req);
      } catch (error) {
        if (error instanceof InputError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        return Response.json({ error: "File manager failed." }, {
          status: 500,
        });
      }
    };
  }

  private async serve(
    session: FileSession,
    action: string,
    req: Request,
  ): Promise<Response> {
    const url = new URL(req.url);
    const id = session.instanceId;
    const methods: Record<string, string> = {
      list: "GET",
      download: "GET",
      upload: "POST",
      mkdir: "POST",
      rename: "POST",
      delete: "POST",
    };
    if (!(action in methods)) return missing();
    if (req.method !== methods[action]) {
      return new Response("Method not allowed.", { status: 405 });
    }
    switch (action) {
      case "list": {
        const path = validatePath(url.searchParams.get("path") ?? "", true);
        return Response.json(await this.api.files(id, path));
      }
      case "download": {
        const path = validatePath(url.searchParams.get("path") ?? "");
        const bytes = await this.api.read(id, path);
        const name = path.split("/").pop() ?? "download";
        return new Response(new Blob([bytes.buffer as ArrayBuffer]), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Disposition": `attachment; filename="${
              name.replaceAll("\\", "_").replaceAll('"', "_")
            }"`,
          },
        });
      }
      case "upload": {
        const path = validatePath(url.searchParams.get("path") ?? "", true);
        const length = Number(req.headers.get("content-length") ?? 0);
        if (length > MAX_FILE_BYTES + 1024 * 1024) {
          throw new InputError("Uploads cannot exceed 128 MiB.");
        }
        const form = await req.formData();
        const file = form.get("file");
        if (!(file instanceof File)) {
          throw new InputError("Choose a file to upload.");
        }
        const filename = file.name.split("/").pop() ?? file.name;
        const target = path ? `${path}/${filename}` : filename;
        const result = await this.api.write(id, target, file, filename);
        return Response.json(result);
      }
      case "mkdir": {
        const body = await this.body(req);
        return Response.json(
          await this.api.mutate(id, "mkdir", validatePath(body.path)),
        );
      }
      case "rename": {
        const body = await this.body(req);
        return Response.json(
          await this.api.mutate(id, "rename", validatePath(body.path), {
            destination: validatePath(body.destination),
          }),
        );
      }
      case "delete": {
        const body = await this.body(req);
        return Response.json(
          await this.api.mutate(id, "delete", validatePath(body.path), {
            recursive: body.recursive === true,
          }),
        );
      }
    }
    return missing();
  }

  private async body(
    req: Request,
  ): Promise<{ path: string; destination: string; recursive: boolean }> {
    const body = await req.json().catch(() => {
      throw new InputError("Send a JSON body.");
    });
    if (typeof body?.path !== "string") {
      throw new InputError("Send a JSON body with a path.");
    }
    return body;
  }
}
