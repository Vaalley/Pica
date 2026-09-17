import { deepStrictEqual, equal, ok } from "node:assert/strict";
import { PicaApi } from "./api.ts";
import { FileManager } from "./filemanager.ts";

const TTL = 3_600_000;
const secret = "test-secret-".repeat(4);

type Call = { url: string; fields: Record<string, unknown>; form?: FormData };

function setup(respond?: (call: Call) => Response) {
  const calls: Call[] = [];
  const api = new PicaApi("http://127.0.0.1:8091/", secret, (input, init) => {
    const call: Call = { url: String(input), fields: {} };
    if (init?.body instanceof FormData) call.form = init.body;
    else if (typeof init?.body === "string") {
      call.fields = JSON.parse(init.body);
    }
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
    () => now.t,
  );
  return { calls, fm, handle: fm.handler(), now, used };
}

const tokenOf = (url: string) => url.split("/f/")[1];

Deno.test("issue returns a URL whose token authenticates and slides expiry", async () => {
  const { fm, handle, now, used } = setup(() =>
    Response.json({ path: "", entries: [] })
  );
  const url = fm.issue("owner1", "survival");
  equal(url.startsWith("https://files.example.com/f/"), true);
  const token = tokenOf(url);
  equal(fm.sessions.get(token)?.expires, 1_000 + TTL);

  const page = await handle(new Request(url));
  equal(page.status, 200);
  equal(page.headers.get("Content-Type"), "text/html; charset=utf-8");
  const html = await page.text();
  ok(html.includes('"/f/" + token + "/api/"'));

  now.t += 100;
  const list = await handle(
    new Request(`${url}/api/list?path=`, { method: "GET" }),
  );
  equal(list.status, 200);
  deepStrictEqual(await list.json(), { path: "", entries: [] });
  equal(fm.sessions.get(token)?.expires, now.t + TTL);
  deepStrictEqual(used, ["owner1", "owner1"]);
});

Deno.test("unknown and expired tokens get a 404 page", async () => {
  const { fm, handle, now } = setup();
  equal((await handle(new Request("https://x/f/nope"))).status, 404);
  equal((await handle(new Request("https://x/other"))).status, 404);
  const url = fm.issue("owner1", "survival");
  now.t += TTL + 1;
  equal((await handle(new Request(url))).status, 404);
});

Deno.test("revoke drops only that owner's sessions", async () => {
  const { fm, handle } = setup(() => Response.json({ path: "", entries: [] }));
  const mine = fm.issue("owner1", "survival");
  const other = fm.issue("owner2", "creative");
  fm.revoke("owner1");
  equal((await handle(new Request(mine))).status, 404);
  equal((await handle(new Request(other))).status, 200);
});

Deno.test("list, mkdir, rename and delete proxy to the fs endpoints", async () => {
  const { calls, fm, handle } = setup((call) =>
    call.url.endsWith("fs/list")
      ? Response.json({ path: "plugins", entries: [] })
      : Response.json({ ok: true, path: "x", restartRequired: false })
  );
  const url = fm.issue("owner1", "survival");
  const base = `${url}/api`;
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const list = await handle(
    new Request(`${base}/list?path=${encodeURIComponent("plugins")}`),
  );
  equal(list.status, 200);
  deepStrictEqual(await list.json(), { path: "plugins", entries: [] });
  equal(calls[0].url, "http://127.0.0.1:8091/instance/survival/fs/list");
  equal(calls[0].fields.path, "plugins");

  equal(
    (await handle(new Request(`${base}/mkdir`, json({ path: "a/b" })))).status,
    200,
  );
  equal(calls[1].url, "http://127.0.0.1:8091/instance/survival/fs/mkdir");
  equal(calls[1].fields.path, "a/b");

  equal(
    (await handle(
      new Request(
        `${base}/rename`,
        json({ path: "a", destination: "b/c" }),
      ),
    )).status,
    200,
  );
  equal(calls[2].url, "http://127.0.0.1:8091/instance/survival/fs/rename");
  equal(calls[2].fields.path, "a");
  equal(calls[2].fields.destination, "b/c");

  equal(
    (await handle(
      new Request(`${base}/delete`, json({ path: "a", recursive: true })),
    )).status,
    200,
  );
  equal(calls[3].url, "http://127.0.0.1:8091/instance/survival/fs/delete");
  equal(calls[3].fields.recursive, true);
});

Deno.test("upload forwards the file into the target directory", async () => {
  const { calls, fm, handle } = setup(() =>
    Response.json({ path: "plugins/jar.jar", bytes: 3, restartRequired: false })
  );
  const url = fm.issue("owner1", "survival");
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2, 3])], "jar.jar"));
  const response = await handle(
    new Request(
      `${url}/api/upload?path=${encodeURIComponent("plugins")}`,
      { method: "POST", body: form },
    ),
  );
  equal(response.status, 200);
  deepStrictEqual(await response.json(), {
    path: "plugins/jar.jar",
    bytes: 3,
    restartRequired: false,
  });
  equal(calls[0].url, "http://127.0.0.1:8091/instance/survival/fs/write");
  equal(calls[0].form?.get("path"), "plugins/jar.jar");
  equal((calls[0].form?.get("file") as File).name, "jar.jar");
});

Deno.test("download returns the file bytes as an attachment", async () => {
  const { calls, fm, handle } = setup(() =>
    new Response(new Uint8Array([9, 8, 7]))
  );
  const url = fm.issue("owner1", "survival");
  const response = await handle(
    new Request(
      `${url}/api/download?path=${encodeURIComponent("logs/latest.log")}`,
    ),
  );
  equal(response.status, 200);
  equal(
    response.headers.get("Content-Disposition"),
    'attachment; filename="latest.log"',
  );
  deepStrictEqual([...new Uint8Array(await response.arrayBuffer())], [9, 8, 7]);
  equal(calls[0].url, "http://127.0.0.1:8091/instance/survival/fs/read");
  equal(calls[0].fields.path, "logs/latest.log");
});

Deno.test("invalid paths are rejected with 400 before touching the API", async () => {
  const { calls, fm, handle } = setup();
  const url = fm.issue("owner1", "survival");
  const base = `${url}/api`;
  const json = (body: unknown) => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  for (const bad of ["../x", "a\\b", "/abs"]) {
    const response = await handle(
      new Request(`${base}/list?path=${encodeURIComponent(bad)}`),
    );
    equal(response.status, 400);
    equal(typeof (await response.json()).error, "string");
  }
  equal(
    (await handle(new Request(`${base}/mkdir`, json({ path: "" })))).status,
    400,
  );
  equal(
    (await handle(
      new Request(`${base}/rename`, json({ path: "a", destination: "../b" })),
    )).status,
    400,
  );
  equal(
    (await handle(
      new Request(`${base}/upload?path=${encodeURIComponent("../x")}`, {
        method: "POST",
        body: new FormData(),
      }),
    )).status,
    400,
  );
  equal(calls.length, 0);
});

Deno.test("API failures map to 400 for InputError and 500 otherwise", async () => {
  const { fm, handle } = setup(() =>
    Response.json({ error: "disk full" }, { status: 500 })
  );
  const url = fm.issue("owner1", "survival");
  const response = await handle(
    new Request(`${url}/api/list?path=plugins`),
  );
  equal(response.status, 500);
  deepStrictEqual(await response.json(), { error: "File manager failed." });
});

Deno.test("wrong methods and unknown routes are rejected", async () => {
  const { fm, handle } = setup();
  const url = fm.issue("owner1", "survival");
  equal(
    (await handle(new Request(`${url}/api/list`, { method: "POST" }))).status,
    405,
  );
  equal(
    (await handle(new Request(`${url}/api/upload`))).status,
    405,
  );
  equal((await handle(new Request(`${url}/api/nope`))).status, 404);
  equal((await handle(new Request(`${url}/other`))).status, 404);
});
