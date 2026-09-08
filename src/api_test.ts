import { deepStrictEqual, equal, rejects, throws } from "node:assert/strict";
import {
  InputError,
  MAX_FILE_BYTES,
  PicaApi,
  PicaApiError,
  readBytes,
  validateCommand,
  validateId,
  validatePath,
} from "./api.ts";

const secret = "test-secret-".repeat(4);
function mockApi(response = () => Response.json({ ok: true })) {
  const requests: Request[] = [];
  const api = new PicaApi("http://127.0.0.1:8091/", secret, (input, init) => {
    requests.push(new Request(input, init));
    return Promise.resolve(response());
  });
  return { api, requests };
}

Deno.test("all JSON operations use exact documented fields, POST and server-side authentication", async () => {
  const { api, requests } = mockApi();
  await api.list();
  await api.create("survival", true);
  for (
    const action of ["status", "start", "stop", "restart", "delete"] as const
  ) {
    await api.instance("survival", action);
  }
  await api.tail("survival");
  await api.run("survival", "say hello");
  await api.files("survival");
  await api.stat("survival", "boot.jar");
  await api.mutate("survival", "mkdir", "plugins/data");
  await api.mutate("survival", "rename", "a", { destination: "b" });
  await api.mutate("survival", "copy", "a", {
    destination: "b",
    recursive: true,
  });
  await api.mutate("survival", "delete", "a", { recursive: true });
  await api.mutate("survival", "chmod", "a", { mode: 0o644 });
  const expected: [string, Record<string, unknown>][] = [
    ["/instance/list", {}],
    ["/instance/create", { id: "survival", eulaAccepted: true }],
    ...["status", "start", "stop", "restart", "delete", "tail"].map((
      action,
    ): [string, Record<string, unknown>] => [
      `/instance/survival/${action}`,
      {},
    ]),
    ["/instance/survival/run", { command: "say hello" }],
    ["/instance/survival/fs/list", { path: "" }],
    ["/instance/survival/fs/stat", { path: "boot.jar" }],
    ["/instance/survival/fs/mkdir", { path: "plugins/data" }],
    ["/instance/survival/fs/rename", { path: "a", destination: "b" }],
    ["/instance/survival/fs/copy", {
      path: "a",
      destination: "b",
      recursive: true,
    }],
    ["/instance/survival/fs/delete", { path: "a", recursive: true }],
    ["/instance/survival/fs/chmod", { path: "a", mode: 420 }],
  ];
  equal(requests.length, expected.length);
  for (let i = 0; i < requests.length; i++) {
    equal(new URL(requests[i].url).pathname, expected[i][0]);
    equal(requests[i].method, "POST");
    equal(requests[i].headers.get("content-type"), "application/json");
    equal(requests[i].redirect, "error");
    deepStrictEqual(await requests[i].json(), { ...expected[i][1], secret });
  }
});

Deno.test("binary reads and multipart writes preserve bytes and part order", async () => {
  const data = new Uint8Array([0, 255, 1, 128]);
  const { api, requests } = mockApi(() => new Response(data));
  deepStrictEqual(await api.read("a", "world/level.dat"), data);
  equal(new URL(requests[0].url).pathname, "/instance/a/fs/read");
  deepStrictEqual(await requests[0].json(), {
    path: "world/level.dat",
    secret,
  });
  const upload = mockApi();
  await upload.api.write("a", "boot.jar", new Blob([data]), "server.jar");
  const request = upload.requests[0];
  equal(new URL(request.url).pathname, "/instance/a/fs/write");
  equal(request.method, "POST");
  const form = await request.formData();
  deepStrictEqual([...form.keys()], ["secret", "path", "file"]);
  equal(form.get("secret"), secret);
  equal(form.get("path"), "boot.jar");
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("Expected binary file part");
  equal(file.name, "server.jar");
  deepStrictEqual(new Uint8Array(await file.arrayBuffer()), data);
});

Deno.test("invalid IDs, paths, commands, EULA and permission bits are rejected before requests", () => {
  const { api, requests } = mockApi();
  for (const id of ["A", "-a", "a-", "a/b", "", "a".repeat(33)]) {
    throws(() => validateId(id), InputError);
  }
  for (const id of ["a", "a-b", "a".repeat(32)]) equal(validateId(id), id);
  for (const path of ["../x", "/etc", "C:/file", "a\\b", "a/../b", "a\n"]) {
    throws(() => validatePath(path), InputError);
  }
  throws(() => validatePath("./"), InputError);
  equal(validatePath("./plugins//config.yml"), "plugins/config.yml");
  equal(validatePath(".", true), "");
  for (
    const command of [
      "",
      "  ",
      "/list",
      " /list",
      "say a\nsay b",
      "a\rb",
      "x".repeat(4097),
    ]
  ) throws(() => validateCommand(command), InputError);
  equal(validateCommand("x".repeat(4096)).length, 4096);
  throws(() => api.create("a", false), InputError);
  for (const mode of [-1, 512, 1.5, undefined]) {
    throws(() => api.mutate("a", "chmod", "file", { mode }), InputError);
  }
  throws(() => api.mutate("a", "delete", ".", { recursive: true }), InputError);
  equal(requests.length, 0);
});

Deno.test("API errors, including binary download failures, redact the secret", async () => {
  const { api } = mockApi(() =>
    Response.json({ error: `busy ${secret}` }, { status: 409 })
  );
  await rejects(
    () => api.list(),
    (error: unknown) =>
      error instanceof PicaApiError && error.status === 409 &&
      error.message === "busy [redacted]",
  );
  await rejects(() => api.read("a", "boot.jar"), PicaApiError);
});

Deno.test("bounded transfers reject oversized headers and actual streams", async () => {
  await rejects(
    () =>
      readBytes(
        new Response("x", {
          headers: { "content-length": String(MAX_FILE_BYTES + 1) },
        }),
        MAX_FILE_BYTES,
      ),
    InputError,
  );
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(4));
      controller.enqueue(new Uint8Array(4));
    },
    cancel() {
      canceled = true;
    },
  });
  await rejects(() => readBytes(new Response(stream), 5), InputError);
  equal(canceled, true);
});
