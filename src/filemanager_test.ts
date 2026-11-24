import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { PicaApi } from "./api.ts";
import { FileManager } from "./filemanager.ts";

const TTL = 3_600_000;
const secret = "test-secret-".repeat(4);
const bridgeKey = "bridge-secret-".repeat(3);

type Call = { url: string; fields: Record<string, unknown>; headers: Headers };

function setup(respond?: (call: Call) => Response) {
  const calls: Call[] = [];
  const upstreamCalls: Request[] = [];
  const api = new PicaApi("http://127.0.0.1:8091/", secret, (input, init) => {
    const fields = typeof init?.body === "string" ? JSON.parse(init.body) : {};
    const call = {
      url: String(input),
      fields,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    return Promise.resolve(
      respond?.(call) ?? Response.json({ ok: true, path: "x" }),
    );
  });
  const used: string[] = [];
  const now = { t: 1_000 };
  const fm = new FileManager(
    api,
    "https://files.example.com",
    (id) => used.push(id),
    "http://127.0.0.1:8080",
    bridgeKey,
    () => now.t,
    (input, init) => {
      upstreamCalls.push(new Request(input, init));
      return Promise.resolve(new Response("filebrowser", { status: 200 }));
    },
  );
  return { calls, fm, handle: fm.handler(), now, upstreamCalls, used };
}

const tokenOf = (url: string) => url.split("/f/")[1];
const bridgeHeaders = (token: string) => ({
  "Content-Type": "application/json",
  "X-Pica-File-Session": token,
  "X-Pica-Filebrowser-Bridge-Key": bridgeKey,
});

Deno.test("file link establishes a private cookie and proxies FileBrowser requests", async () => {
  const { fm, handle, now, upstreamCalls, used } = setup();
  const url = fm.issue("owner1", "survival");
  const token = tokenOf(url);

  const entry = await handle(new Request(url));
  equal(entry.status, 303);
  equal(entry.headers.get("location"), "/");
  ok(entry.headers.get("set-cookie")?.includes(`pica_file_session=${token}`));
  ok(entry.headers.get("set-cookie")?.includes("HttpOnly"));
  ok(entry.headers.get("set-cookie")?.includes("Secure"));

  const proxied = await handle(
    new Request("https://files.example.com/api/resources", {
      headers: {
        Cookie: `pica_file_session=${token}`,
        "X-Pica-File-Session": "attacker",
      },
    }),
  );
  equal(proxied.status, 200);
  equal(await proxied.text(), "filebrowser");
  equal(upstreamCalls.length, 1);
  equal(upstreamCalls[0].url, "http://127.0.0.1:8080/api/resources");
  equal(upstreamCalls[0].headers.get("X-Pica-File-Session"), token);
  equal(upstreamCalls[0].headers.get("cookie"), null);
  ok(proxied.headers.get("set-cookie")?.includes(`pica_file_session=${token}`));
  equal(fm.sessions.get(token)?.expires, now.t + TTL);
  deepStrictEqual(used, ["owner1", "owner1"]);
});

Deno.test("unknown, expired, and revoked browser sessions are hidden", async () => {
  const { fm, handle, now } = setup();
  equal((await handle(new Request("https://files.example.com/"))).status, 404);
  const url = fm.issue("owner1", "survival");
  const token = tokenOf(url);
  now.t += TTL + 1;
  equal((await handle(new Request(url))).status, 404);
  const active = fm.issue("owner1", "survival");
  fm.revoke("owner1");
  equal((await handle(new Request(active))).status, 404);
  equal(fm.sessions.has(token), false);
});

Deno.test("bridge requires its private key and a live browser session", async () => {
  const { fm } = setup();
  const bridge = fm.bridgeHandler();
  const url = fm.issue("owner1", "survival");
  const token = tokenOf(url);
  const target = "http://127.0.0.1:8093/v1/fs/list";

  equal(
    (await bridge(
      new Request(target, {
        method: "POST",
        headers: { "X-Pica-File-Session": token },
        body: JSON.stringify({ path: "" }),
      }),
    )).status,
    404,
  );
  equal(
    (await bridge(
      new Request(target, {
        method: "POST",
        headers: { ...bridgeHeaders("expired") },
        body: JSON.stringify({ path: "" }),
      }),
    )).status,
    404,
  );
});

Deno.test("bridge maps virtual filesystem operations to the bound instance", async () => {
  const { calls, fm } = setup((call) =>
    call.url.endsWith("fs/list")
      ? Response.json({ path: "plugins", entries: [] })
      : Response.json({ ok: true, path: "x", restartRequired: false })
  );
  const bridge = fm.bridgeHandler();
  const token = tokenOf(fm.issue("owner1", "survival"));
  const request = (action: string, body: unknown) =>
    bridge(
      new Request(
        `http://127.0.0.1:8093/v1/fs/${action}`,
        {
          method: "POST",
          headers: bridgeHeaders(token),
          body: JSON.stringify(body),
        },
      ),
    );

  const listed = await request("list", { path: "plugins" });
  equal(listed.status, 200);
  deepStrictEqual(await listed.json(), { path: "plugins", entries: [] });
  equal(calls[0].url, "http://127.0.0.1:8091/instance/survival/fs/list");
  equal(calls[0].fields.path, "plugins");

  equal((await request("mkdir", { path: "plugins/data" })).status, 200);
  equal(calls[1].url, "http://127.0.0.1:8091/instance/survival/fs/mkdir");
  equal(calls[1].fields.path, "plugins/data");

  equal((await request("rename", { path: "a", destination: "b" })).status, 200);
  equal(calls[2].url, "http://127.0.0.1:8091/instance/survival/fs/rename");
  equal(calls[2].fields.destination, "b");

  equal(
    (await request("copy", { path: "a", destination: "b", recursive: true }))
      .status,
    200,
  );
  equal(calls[3].url, "http://127.0.0.1:8091/instance/survival/fs/copy");
  equal(calls[3].fields.recursive, true);

  equal((await request("chmod", { path: "a", mode: 0o644 })).status, 200);
  equal(calls[4].url, "http://127.0.0.1:8091/instance/survival/fs/chmod");
  equal(calls[4].fields.mode, 0o644);
});

Deno.test("bridge streams content requests to the bound instance", async () => {
  const { calls, fm } = setup((call) =>
    call.url.includes("/fs/content?")
      ? new Response(new Uint8Array([9, 8, 7]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-2/9" },
      })
      : Response.json({ ok: true })
  );
  const token = tokenOf(fm.issue("owner1", "survival"));
  const response = await fm.bridgeHandler()(
    new Request(
      "http://127.0.0.1:8093/v1/fs/content?path=logs/latest.log",
      {
        headers: {
          "Range": "bytes=0-2",
          "X-Pica-File-Session": token,
          "X-Pica-Filebrowser-Bridge-Key": bridgeKey,
        },
      },
    ),
  );

  equal(response.status, 206);
  equal(response.headers.get("Content-Range"), "bytes 0-2/9");
  deepStrictEqual([...new Uint8Array(await response.arrayBuffer())], [9, 8, 7]);
  equal(
    calls[0].url,
    "http://127.0.0.1:8091/instance/survival/fs/content?path=logs%2Flatest.log",
  );
  equal(calls[0].headers.get("range"), "bytes=0-2");
});

Deno.test("bridge rejects invalid paths and methods before calling Pica", async () => {
  const { calls, fm } = setup();
  const token = tokenOf(fm.issue("owner1", "survival"));
  const bridge = fm.bridgeHandler();
  const request = (path: string, method = "POST") =>
    bridge(
      new Request(
        `http://127.0.0.1:8093/v1/fs/list`,
        {
          method,
          headers: bridgeHeaders(token),
          body: method === "GET" || method === "HEAD"
            ? undefined
            : JSON.stringify({ path }),
        },
      ),
    );

  for (const path of ["../x", "a\\b", "/abs"]) {
    equal((await request(path)).status, 400);
  }
  equal((await request("", "GET")).status, 405);
  equal(calls.length, 0);
});
