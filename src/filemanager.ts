import { InputError, MAX_FILE_BYTES, PicaApi, validatePath } from "./api.ts";

export type FileSession = {
  ownerId: string;
  instanceId: string;
  expires: number;
};

type FilebrowserAction =
  | "status"
  | "list"
  | "stat"
  | "mkdir"
  | "rename"
  | "copy"
  | "delete"
  | "chmod";

const SESSION_TTL = 3_600_000;
const SESSION_COOKIE = "pica_file_session";
const SESSION_HEADER = "X-Pica-File-Session";
const BRIDGE_HEADER = "X-Pica-Filebrowser-Bridge-Key";

function missing(): Response {
  return new Response(
    "<!doctype html><title>Not found</title><p>This link is invalid or has expired.</p>",
    { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function methodNotAllowed(): Response {
  return new Response("Method not allowed.", { status: 405 });
}

function cookie(name: string, value: string, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${
    SESSION_TTL / 1_000
  }${secure ? "; Secure" : ""}`;
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (!header) return undefined;
  for (const item of header.split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function jsonHeaders(req: Request): boolean {
  return req.headers.get("content-type")?.split(";", 1)[0] ===
    "application/json";
}

/**
 * Public FileBrowser gateway and private Pica filesystem bridge.
 *
 * The public gateway authenticates the browser with a short-lived cookie and
 * forwards its original session identifier only to FileBrowser. FileBrowser
 * must attach that identifier plus the bridge key to each private bridge call.
 */
export class FileManager {
  readonly sessions = new Map<string, FileSession>();
  private readonly secureCookie: boolean;

  constructor(
    private api: PicaApi,
    private baseUrl: string,
    private onUse: (ownerId: string) => void,
    private filebrowserUrl: string,
    private bridgeKey: string,
    private now = Date.now,
    private request: typeof fetch = fetch,
  ) {
    const publicUrl = new URL(baseUrl);
    const upstreamUrl = new URL(filebrowserUrl);
    if (
      !["http:", "https:"].includes(upstreamUrl.protocol) ||
      upstreamUrl.username || upstreamUrl.password || upstreamUrl.search ||
      upstreamUrl.hash
    ) {
      throw new Error(
        "PICA_FILEBROWSER_URL must be an HTTP(S) URL without credentials, query, or fragment.",
      );
    }
    if (bridgeKey.length < 32) {
      throw new Error(
        "PICA_FILEBROWSER_BRIDGE_KEY must contain at least 32 characters.",
      );
    }
    this.baseUrl = publicUrl.toString().replace(/\/+$/, "");
    this.filebrowserUrl = upstreamUrl.toString().replace(/\/+$/, "");
    this.secureCookie = publicUrl.protocol === "https:";
  }

  issue(ownerId: string, instanceId: string): string {
    for (const [token, session] of this.sessions) {
      if (session.expires <= this.now()) {
        this.sessions.delete(token);
      } else if (
        session.ownerId === ownerId && session.instanceId === instanceId
      ) {
        session.expires = this.now() + SESSION_TTL;
        return `${this.baseUrl}/f/${token}`;
      }
    }
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
      const url = new URL(req.url);
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments[0] === "f" && segments.length === 2) {
        if (req.method !== "GET" && req.method !== "HEAD") {
          return methodNotAllowed();
        }
        const session = this.use(segments[1]);
        if (!session) return missing();
        const headers = new Headers({
          Location: "/",
          "Cache-Control": "no-store",
        });
        headers.append(
          "Set-Cookie",
          cookie(SESSION_COOKIE, segments[1], this.secureCookie),
        );
        return new Response(null, { status: 303, headers });
      }
      const token = cookieValue(req.headers.get("cookie"), SESSION_COOKIE);
      const session = token ? this.use(token) : undefined;
      if (!session || !token) return missing();
      return await this.proxy(req, token);
    };
  }

  bridgeHandler(): (req: Request) => Promise<Response> {
    return async (req) => {
      if (req.headers.get(BRIDGE_HEADER) !== this.bridgeKey) return missing();
      const token = req.headers.get(SESSION_HEADER);
      const session = token ? this.use(token) : undefined;
      if (!session) return missing();
      const segments = new URL(req.url).pathname.split("/").filter(Boolean);
      if (segments[0] !== "v1" || segments[1] !== "fs") return missing();
      try {
        if (segments.length === 3 && segments[2] === "content") {
          return await this.content(session, req);
        }
        if (segments.length !== 3) return missing();
        return await this.action(
          session,
          segments[2] as FilebrowserAction,
          req,
        );
      } catch (error) {
        if (error instanceof InputError) {
          return Response.json({ error: error.message }, { status: 400 });
        }
        return Response.json({ error: "File manager bridge failed." }, {
          status: 500,
        });
      }
    };
  }

  private use(token: string): FileSession | undefined {
    const session = this.sessions.get(token);
    if (!session || session.expires <= this.now()) {
      if (session) this.sessions.delete(token);
      return undefined;
    }
    session.expires = this.now() + SESSION_TTL;
    this.onUse(session.ownerId);
    return session;
  }

  private async proxy(req: Request, token: string): Promise<Response> {
    const requestUrl = new URL(req.url);
    const upstream = new URL(
      `${this.filebrowserUrl}${requestUrl.pathname}${requestUrl.search}`,
    );
    const headers = new Headers(req.headers);
    headers.delete("cookie");
    headers.delete("host");
    headers.delete(SESSION_HEADER);
    headers.delete(BRIDGE_HEADER);
    headers.set(SESSION_HEADER, token);
    const response = await this.request(upstream, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD"
        ? undefined
        : req.body,
      redirect: "manual",
    });
    const responseHeaders = new Headers(response.headers);
    // Deno's fetch transparently decompresses gzip/br bodies from upstream.
    // Forwarding the original content-encoding or content-length makes
    // browsers try to decode an already-decoded stream → ERR_FAILED.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("transfer-encoding");
    responseHeaders.delete("set-cookie");
    responseHeaders.set("Cache-Control", "no-store");
    responseHeaders.append(
      "Set-Cookie",
      cookie(SESSION_COOKIE, token, this.secureCookie),
    );
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  private async content(session: FileSession, req: Request): Promise<Response> {
    if (!["GET", "HEAD", "PUT"].includes(req.method)) {
      return methodNotAllowed();
    }
    const url = new URL(req.url);
    const path = validatePath(url.searchParams.get("path") ?? "");
    if (req.method === "PUT") {
      const length = Number(req.headers.get("content-length") ?? 0);
      if (length > MAX_FILE_BYTES) {
        throw new InputError("Uploads cannot exceed 128 MiB.");
      }
    }
    return await this.api.content(session.instanceId, path, req);
  }

  private async action(
    session: FileSession,
    action: FilebrowserAction,
    req: Request,
  ): Promise<Response> {
    const methods: Record<FilebrowserAction, string> = {
      status: "POST",
      list: "POST",
      stat: "POST",
      mkdir: "POST",
      rename: "POST",
      copy: "POST",
      delete: "POST",
      chmod: "POST",
    };
    if (!(action in methods)) return missing();
    if (req.method !== methods[action]) return methodNotAllowed();
    if (!jsonHeaders(req)) throw new InputError("Send a JSON body.");
    const body = await req.json().catch(() => {
      throw new InputError("Send a JSON body.");
    });
    if (action === "status") {
      return Response.json(
        await this.api.instance(session.instanceId, "status"),
      );
    }
    if (typeof body?.path !== "string") {
      throw new InputError("Send a JSON body with a path.");
    }
    const id = session.instanceId;
    switch (action) {
      case "list":
        return Response.json(
          await this.api.files(id, validatePath(body.path, true)),
        );
      case "stat":
        return Response.json(
          await this.api.stat(id, validatePath(body.path, true)),
        );
      case "mkdir":
        return Response.json(
          await this.api.mutate(id, "mkdir", validatePath(body.path)),
        );
      case "rename":
      case "copy":
        return Response.json(
          await this.api.mutate(id, action, validatePath(body.path), {
            destination: validatePath(body.destination ?? ""),
            recursive: body.recursive === true,
          }),
        );
      case "delete":
        return Response.json(
          await this.api.mutate(id, "delete", validatePath(body.path), {
            recursive: body.recursive === true,
          }),
        );
      case "chmod":
        return Response.json(
          await this.api.mutate(id, "chmod", validatePath(body.path), {
            mode: body.mode,
          }),
        );
    }
  }
}
