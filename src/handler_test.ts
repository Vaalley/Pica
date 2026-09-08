import { deepStrictEqual, equal, match, rejects } from "node:assert/strict";
import { type ChatInputCommandInteraction, MessageFlags } from "discord.js";
import {
  InputError,
  type Instance,
  MAX_FILE_BYTES,
  PicaApi,
  PicaApiError,
} from "./api.ts";
import {
  authorized,
  createHandler,
  downloadAttachment,
  errorMessage,
  instanceDetails,
  OperationLocks,
} from "./handler.ts";
import { picaCommand } from "./commands.ts";

const instance: Instance = {
  id: "survival",
  hostname: "survival.pica.host",
  memoryMiB: 3072,
  cpus: 2,
  state: "OPAQUE_NOT_FOR_DISPLAY",
  connections: 2,
  eulaAccepted: true,
  usedBytes: 1024 ** 3,
  storageBlocked: true,
  restartRequired: true,
  storageLimitBytes: 10 * 1024 ** 3,
  diskBytes: 15 * 1024 ** 3,
};
function interaction(
  command: string,
  values: Record<string, unknown> = {},
  group: string | null = null,
  admin = true,
) {
  const events: {
    type: string;
    payload: { content?: string; flags?: number };
  }[] = [];
  const fake = {
    commandName: "pica",
    guildId: "guild",
    memberPermissions: { has: () => admin },
    attachmentSizeLimit: 10 * 1024 ** 2,
    options: {
      getSubcommand: () => command,
      getSubcommandGroup: () => group,
      getString: (name: string) =>
        values[name] ?? (name === "id" ? "survival" : null),
      getInteger: (name: string) => values[name] ?? null,
      getBoolean: (name: string) => values[name] ?? null,
      getAttachment: (name: string) => values[name] ?? null,
    },
    reply: (payload: object) => {
      events.push({ type: "reply", payload });
      return Promise.resolve();
    },
    deferReply: (payload: object) => {
      events.push({ type: "defer", payload });
      return Promise.resolve();
    },
    editReply: (payload: object) => {
      events.push({ type: "edit", payload });
      return Promise.resolve();
    },
  };
  return { value: fake as unknown as ChatInputCommandInteraction, events };
}
function backend() {
  const paths: string[] = [];
  const api = new PicaApi("http://localhost:8091", "s".repeat(32), (url) => {
    paths.push(new URL(String(url)).pathname);
    return Promise.resolve(
      Response.json(
        paths.at(-1)?.includes("/fs/")
          ? { ok: true, path: "world", restartRequired: false }
          : instance,
      ),
    );
  });
  return { paths, handle: createHandler(api, new Set(["guild"])) };
}

Deno.test("command schema serializes and has no stop lifecycle command", () => {
  const data = picaCommand.toJSON();
  equal(data.name, "pica");
  equal(data.default_member_permissions, "8");
  equal(data.dm_permission, false);
  equal(data.options?.some((o) => o.name === "stop"), false);
});

Deno.test("authorization denies DMs, other guilds, and non-admins before any API call", async () => {
  const guilds = new Set(["guild"]);
  equal(authorized(null, true, guilds), false);
  equal(authorized("other", true, guilds), false);
  equal(authorized("guild", false, guilds), false);
  equal(authorized("guild", true, guilds), true);
  const { paths, handle } = backend();
  const denied = interaction("list", {}, null, false);
  await handle(denied.value);
  equal(paths.length, 0);
  equal(denied.events[0].payload.flags, MessageFlags.Ephemeral);
});

Deno.test("restart with active connections requires confirmation, then calls restart", async () => {
  const { paths, handle } = backend();
  const first = interaction("restart");
  await handle(first.value);
  deepStrictEqual(paths, ["/instance/survival/status"]);
  equal(first.events[0].type, "defer");
  equal(first.events[0].payload.flags, MessageFlags.Ephemeral);
  match(first.events.at(-1)!.payload.content!, /disconnect/);
  await handle(interaction("restart", { "confirm-disconnect": true }).value);
  deepStrictEqual(paths.slice(1), [
    "/instance/survival/status",
    "/instance/survival/restart",
  ]);
});

Deno.test("server and recursive file deletion require exact confirmation", async () => {
  const { paths, handle } = backend();
  await handle(interaction("delete", { "confirm-id": "wrong" }).value);
  await handle(
    interaction("delete", {
      path: "world",
      "confirm-path": "wrong",
      recursive: true,
    }, "files").value,
  );
  equal(paths.length, 0);
  await handle(interaction("delete", { "confirm-id": "survival" }).value);
  await handle(
    interaction("delete", {
      path: "world",
      "confirm-path": "world",
      recursive: true,
    }, "files").value,
  );
  deepStrictEqual(paths, [
    "/instance/survival/delete",
    "/instance/survival/fs/delete",
  ]);
});

Deno.test("create refuses missing EULA; upload refuses missing overwrite confirmation", async () => {
  const { paths, handle } = backend();
  await handle(interaction("create", { "accept-eula": false }).value);
  await handle(
    interaction(
      "write",
      { path: "boot.jar", "confirm-replace": false },
      "files",
    ).value,
  );
  equal(paths.length, 0);
});

Deno.test("details display connection/storage warnings without opaque state", () => {
  const text = instanceDetails(instance);
  equal(text.includes(instance.state), false);
  match(text, /TCP sessions/);
  match(text, /1.00 GiB \/ 10.00 GiB/);
  match(text, /Storage blocked/);
  match(text, /Restart required/);
  match(text, /pica files list/);
});

Deno.test("confirmed file deletion reports successful completion", async () => {
  const { handle } = backend();
  const command = interaction("delete", {
    path: "world",
    "confirm-path": "world",
    recursive: true,
  }, "files");
  await handle(command.value);
  match(command.events.at(-1)!.payload.content!, /delete completed: `world`/);
});

Deno.test("expected API failures have actionable messages without exposing configuration errors", () => {
  match(
    errorMessage(new PicaApiError(401, "private configuration")),
    /server configuration/,
  );
  equal(
    errorMessage(new PicaApiError(401, "private configuration")).includes(
      "private configuration",
    ),
    false,
  );
  match(
    errorMessage(new PicaApiError(409, "Players connected")),
    /Players connected/,
  );
  match(errorMessage(new PicaApiError(413, "too large")), /128 MiB/);
  equal(
    errorMessage(new PicaApiError(503, "busy")),
    "All server slots are busy. Try again shortly.",
  );
  match(
    errorMessage(new DOMException("timeout", "TimeoutError")),
    /may still finish/,
  );
});

Deno.test("same-server mutations cannot overlap and locks release after failures", async () => {
  const locks = new OperationLocks();
  let release!: () => void;
  const pending = locks.run("a", () =>
    new Promise<void>((resolve) => {
      release = resolve;
    }));
  await rejects(() => locks.run("a", () => Promise.resolve()), InputError);
  equal(await locks.run("b", () => Promise.resolve(42)), 42);
  release();
  await pending;
  await rejects(() =>
    locks.run("a", () => Promise.reject(new Error("failed")))
  );
  equal(await locks.run("a", () => Promise.resolve(42)), 42);
});

Deno.test("attachment fetching rejects arbitrary URLs and oversized files before network access", async () => {
  let requests = 0;
  const fetcher: typeof fetch = (_url, init) => {
    requests++;
    equal(init?.redirect, "error");
    return Promise.resolve(new Response(new Uint8Array([0, 255])));
  };
  for (
    const url of [
      "http://127.0.0.1/attachments/x",
      "https://cdn.discordapp.com.evil.test/attachments/x",
      "https://cdn.discordapp.com/other/x",
    ]
  ) {
    await rejects(() => downloadAttachment(url, 1, fetcher), InputError);
  }
  await rejects(
    () =>
      downloadAttachment(
        "https://cdn.discordapp.com/attachments/x",
        MAX_FILE_BYTES + 1,
        fetcher,
      ),
    InputError,
  );
  equal(requests, 0);
  deepStrictEqual(
    await downloadAttachment(
      "https://cdn.discordapp.com/attachments/x",
      2,
      fetcher,
    ),
    new Uint8Array([0, 255]),
  );
});
