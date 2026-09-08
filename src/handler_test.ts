import { equal, match, rejects, throws } from "node:assert/strict";
import { MessageFlags, PermissionFlagsBits as P } from "discord.js";
import { InputError, MAX_FILE_BYTES } from "./api.ts";
import { commands } from "./commands.ts";
import { downloadAttachment } from "./common.ts";
import { Confirmations } from "./confirmations.ts";
import { privateOverwrites } from "./discord.ts";
import { createHandler, type PortalInteraction } from "./handler.ts";
import { fixture, instance } from "./test_helpers.ts";
import { serverPanel } from "./ui.ts";

function interaction(
  kind: "button" | "slash" | "modal",
  name: string,
  userId = "alice",
  channelId = "channel-alice",
  values: Record<string, unknown> = {},
) {
  const events: Record<string, unknown>[] = [];
  const fake = {
    commandName: name,
    customId: name,
    guildId: "guild",
    channelId,
    user: { id: userId },
    message: { id: "welcome" },
    deferred: false,
    replied: false,
    attachmentSizeLimit: 10 * 1024 ** 2,
    memberPermissions: { has: () => false },
    isChatInputCommand: () => kind === "slash",
    isButton: () => kind === "button",
    isModalSubmit: () => kind === "modal",
    options: {
      getString: (key: string) => values[key] ?? null,
      getBoolean: (key: string) => values[key] ?? null,
      getInteger: (key: string) => values[key] ?? null,
      getSubcommand: () => values.subcommand,
    },
    fields: { getTextInputValue: () => values.confirmation ?? "ACCEPT" },
    deferReply(payload: object) {
      fake.deferred = true;
      events.push({ type: "defer", ...payload });
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
const setup = { setup: () => Promise.resolve("lobby") };

Deno.test("ordinary members create through the lobby and receive their private channel", async () => {
  const f = fixture();
  try {
    const handler = createHandler(f.service, setup, new Set(["guild"]));
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

Deno.test("commands and buttons deny a different owner before contacting Pica", async () => {
  const f = fixture();
  try {
    await f.service.create("guild", "alice", "ACCEPT");
    const handler = createHandler(f.service, setup, new Set(["guild"]));
    const count = f.requests.length;
    for (const kind of ["slash", "button"] as const) {
      const input = interaction(
        kind,
        kind === "slash" ? "start" : "pica:start",
        "bob",
        "channel-alice",
      );
      await handler(input.value);
      match(String(input.events.at(-1)!.content), /own private server channel/);
    }
    equal(f.requests.length, count);
  } finally {
    f.store.close();
  }
});

Deno.test("owner can start without administrator permission or an instance ID", async () => {
  const f = fixture();
  try {
    const server = await f.service.create("guild", "alice", "ACCEPT");
    const handler = createHandler(f.service, setup, new Set(["guild"]));
    const input = interaction("slash", "start");
    await handler(input.value);
    equal(f.requests.at(-1), `/instance/${server.instanceId}/start`);
    match(String(input.events.at(-1)!.content), /Your server is ready/);
  } finally {
    f.store.close();
  }
});

Deno.test("public channel control attempts and non-admin setup are denied", async () => {
  const f = fixture();
  try {
    await f.service.create("guild", "alice", "ACCEPT");
    const handler = createHandler(f.service, setup, new Set(["guild"]));
    const count = f.requests.length;
    await handler(interaction("slash", "start", "alice", "lobby").value);
    const input = interaction("slash", "setup", "alice", "lobby");
    await handler(input.value);
    match(String(input.events.at(-1)!.content), /administrator/);
    equal(f.requests.length, count);
  } finally {
    f.store.close();
  }
});

Deno.test("restart requires a one-use confirmation and cannot be replayed", async () => {
  const f = fixture();
  try {
    const server = await f.service.create("guild", "alice", "ACCEPT");
    const handler = createHandler(f.service, setup, new Set(["guild"]));
    const first = interaction("button", "pica:restart");
    await handler(first.value);
    equal(f.requests.some((p) => p.endsWith("/restart")), false);
    const row = first.events[0].components as {
      toJSON(): { components: { custom_id: string }[] };
    }[];
    const customId = row[0].toJSON().components[0].custom_id;
    await handler(interaction("button", customId).value);
    equal(f.requests.at(-1), `/instance/${server.instanceId}/restart`);
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
    const alice = f.store.reserve("alice", "guild");
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
  equal(permissions[2].allow.includes(P.UseApplicationCommands), true);
  equal(permissions[2].deny.includes(P.ManageChannels), true);
});

Deno.test("personal command schemas have no ID option or admin requirement; panel omits backend state", () => {
  for (const c of commands) {
    const json = c.toJSON();
    if (json.name === "setup") equal(json.default_member_permissions, "8");
    else equal(json.default_member_permissions == null, true);
    equal(JSON.stringify(json).includes('"name":"id"'), false);
  }
  const f = fixture();
  try {
    const server = f.store.reserve("alice", "guild");
    server.phase = "ready";
    const panel = serverPanel(server, {
      ...instance(server.instanceId),
      storageBlocked: true,
    });
    const text = JSON.stringify(panel);
    equal(text.includes("OPAQUE"), false);
    match(text, /Storage is full/);
    match(text, /pica:start/);
    match(text, /pica:stop/);
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
