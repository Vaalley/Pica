import { equal, match, rejects, throws } from "node:assert/strict";
import { MessageFlags, PermissionFlagsBits as P } from "discord.js";
import { InputError, MAX_FILE_BYTES } from "./api.ts";
import { Catalogs } from "./catalogs.ts";
import { downloadAttachment } from "./common.ts";
import { Confirmations } from "./confirmations.ts";
import { privateOverwrites } from "./discord.ts";
import { FileManager } from "./filemanager.ts";
import { createHandler, type PortalInteraction } from "./handler.ts";
import { type Fixture, fixture, instance } from "./test_helpers.ts";
import { statusMessage } from "./ui.ts";

function interaction(
  kind: "button" | "modal" | "select",
  name: string,
  userId = "alice",
  channelId = "channel-alice",
  values: Record<string, unknown> = {},
) {
  const events: Record<string, unknown>[] = [];
  const fake = {
    customId: name,
    guildId: "guild",
    channelId,
    user: { id: userId },
    message: { id: "welcome", flags: { has: () => false } },
    deferred: false,
    replied: false,
    attachmentSizeLimit: 10 * 1024 ** 2,
    values: values.values ?? [],
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    isStringSelectMenu: () => kind === "select",
    fields: {
      getTextInputValue: (key: string) => values[key] ?? "ACCEPT",
    },
    deferReply(payload: object) {
      fake.deferred = true;
      events.push({ type: "defer", ...payload });
      return Promise.resolve();
    },
    deferUpdate() {
      fake.deferred = true;
      events.push({ type: "deferUpdate" });
      return Promise.resolve();
    },
    reply(payload: object) {
      fake.replied = true;
      events.push({ type: "reply", ...payload });
      return Promise.resolve();
    },
    editReply(payload: object) {
      events.push({ type: "edit", ...payload });
      return Promise.resolve();
    },
    showModal(payload: { toJSON(): unknown }) {
      fake.replied = true;
      events.push({ type: "modal", modal: payload.toJSON() });
      return Promise.resolve();
    },
    update(payload: object) {
      fake.replied = true;
      events.push({ type: "update", ...payload });
      return Promise.resolve();
    },
  };
  return { value: fake as unknown as PortalInteraction, events };
}
function handlerFor(f: Fixture) {
  const catalogs = new Catalogs(() =>
    Promise.resolve(Response.json({ hits: [] }))
  );
  const files = new FileManager(
    f.api,
    "http://files.test",
    () => f.service.touch("alice"),
  );
  return createHandler(f.service, new Set(["guild"]), catalogs, files);
}

Deno.test("ordinary members create through the lobby and receive their private channel", async () => {
  const f = fixture();
  try {
    const handler = handlerFor(f);
    const button = interaction("button", "pica:create", "alice", "lobby");
    await handler(button.value);
    equal(button.events[0].type, "modal");
    equal(f.remote.size, 0);
    const submit = interaction("modal", "pica:create-submit", "alice", "lobby");
    await handler(submit.value);
    equal(submit.events[0].flags, MessageFlags.Ephemeral);
    match(String(submit.events.at(-1)!.content), /Go to <#channel-alice>/);
    equal(f.remote.size, 1);
  } finally {
    f.store.close();
  }
});

Deno.test("Open existing restores an expired channel and rejects members without a server", async () => {
  const f = fixture();
  try {
    const handler = handlerFor(f);
    const missing = interaction("button", "pica:open", "bob", "lobby");
    await handler(missing.value);
    match(String(missing.events.at(-1)!.content), /don't have a Pica server/);
    await f.service.create("guild", "alice", "ACCEPT");
    f.store.owner("alice")!.channelId = null;
    const open = interaction("button", "pica:open", "alice", "lobby");
    await handler(open.value);
    match(String(open.events.at(-1)!.content), /channel is back/);
    equal(f.store.owner("alice")!.channelId, "channel-alice");
  } finally {
    f.store.close();
  }
});

Deno.test("buttons deny a different owner before contacting Pica", async () => {
  const f = fixture();
  try {
    await f.service.create("guild", "alice", "ACCEPT");
    const handler = handlerFor(f);
    const count = f.requests.length;
    const input = interaction("button", "pica:start", "bob", "channel-alice");
    await handler(input.value);
    match(String(input.events.at(-1)!.content), /own private server channel/);
    equal(f.requests.length, count);
  } finally {
    f.store.close();
  }
});

Deno.test("owner can start without administrator permission or an instance ID", async () => {
  const f = fixture();
  try {
    const server = await f.service.create("guild", "alice", "ACCEPT");
    const handler = handlerFor(f);
    const input = interaction("button", "pica:start");
    await handler(input.value);
    equal(
      f.requests.includes(`/instance/${server.instanceId}/start`),
      true,
    );
    match(String(input.events.at(-1)!.content), /Your server is ready/);
  } finally {
    f.store.close();
  }
});

Deno.test("controls outside the owner's channel are denied", async () => {
  const f = fixture();
  try {
    await f.service.create("guild", "alice", "ACCEPT");
    const handler = handlerFor(f);
    const count = f.requests.length;
    const input = interaction("button", "pica:start", "alice", "lobby");
    await handler(input.value);
    match(String(input.events.at(-1)!.content), /own private server channel/);
    equal(f.requests.length, count);
  } finally {
    f.store.close();
  }
});

Deno.test("restart requires a one-use confirmation and cannot be replayed", async () => {
  const f = fixture();
  try {
    const server = await f.service.create("guild", "alice", "ACCEPT");
    const handler = handlerFor(f);
    const first = interaction("button", "pica:restart");
    await handler(first.value);
    equal(f.requests.some((p) => p.endsWith("/restart")), false);
    const row = first.events[0].components as {
      toJSON(): { components: { custom_id: string }[] };
    }[];
    const customId = row[0].toJSON().components[0].custom_id;
    await handler(interaction("button", customId).value);
    equal(
      f.requests.includes(`/instance/${server.instanceId}/restart`),
      true,
    );
    const count = f.requests.length;
    await handler(interaction("button", customId).value);
    equal(f.requests.length, count);
  } finally {
    f.store.close();
  }
});

Deno.test("confirmations expire and are bound to owner, channel, and instance", () => {
  const f = fixture();
  try {
    const alice = f.store.reserve("alice", "guild", "wild-willow");
    alice.channelId = "channel-alice";
    let now = 0;
    const confirmations = new Confirmations(() => now);
    const token = confirmations.issue(alice, "stop");
    throws(
      () => confirmations.consume(token, { ...alice, ownerId: "bob" }),
      InputError,
    );
    throws(
      () => confirmations.consume(token, { ...alice, channelId: "other" }),
      InputError,
    );
    throws(
      () => confirmations.consume(token, { ...alice, instanceId: "other" }),
      InputError,
    );
    now = 120_001;
    throws(() => confirmations.consume(token, alice), InputError);
  } finally {
    f.store.close();
  }
});

Deno.test("private channel overwrites grant access only to the bot and owner", () => {
  const permissions = privateOverwrites("guild", "bot", "alice");
  equal(permissions.length, 3);
  equal(permissions[0].deny.includes(P.ViewChannel), true);
  equal(permissions[1].id, "bot");
  equal(permissions[2].id, "alice");
  equal(permissions[2].allow.includes(P.ViewChannel), true);
  equal(permissions[2].deny.includes(P.ManageChannels), true);
});

Deno.test("status message shows power-aware buttons and no backend internals", () => {
  const f = fixture();
  try {
    const server = f.store.reserve("alice", "guild", "wild-willow");
    server.phase = "ready";
    const online = statusMessage(server, {
      ...instance(server.instanceId),
      storageBlocked: true,
    }, true);
    const text = JSON.stringify(online);
    match(text, /Storage is full/);
    match(text, /pica:stop/);
    match(text, /pica:restart/);
    equal(text.includes("pica:start"), false);
    const offline = statusMessage(server, instance(server.instanceId), false);
    const offlineText = JSON.stringify(offline);
    match(offlineText, /pica:start/);
    equal(offlineText.includes("pica:stop"), false);
  } finally {
    f.store.close();
  }
});

Deno.test("attachment downloads reject arbitrary URLs and oversized attachments without requests", async () => {
  let calls = 0;
  const fetcher: typeof fetch = () => {
    calls++;
    return Promise.resolve(new Response("file"));
  };
  await rejects(
    () => downloadAttachment("http://localhost:8091", 10, fetcher),
    InputError,
  );
  await rejects(
    () =>
      downloadAttachment(
        "https://cdn.discordapp.com/attachments/a",
        MAX_FILE_BYTES + 1,
        fetcher,
      ),
    InputError,
  );
  equal(calls, 0);
});
