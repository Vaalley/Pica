import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import {
  ChannelType,
  type Client,
  Collection,
  type Guild,
  PermissionFlagsBits as P,
} from "discord.js";
import { DiscordRooms } from "./discord.ts";
import { Store } from "./store.ts";

type Payload = {
  embeds: { toJSON(): { footer?: { text: string } } }[];
  components?: { toJSON(): { components: { custom_id?: string }[] } }[];
};
type Overwrite = { id: string; allow?: bigint[]; deny?: bigint[] };
type ChannelOptions = {
  name: string;
  topic?: string;
  type: ChannelType;
  parent?: string;
  permissionOverwrites: Overwrite[];
};
function discordFixture() {
  const store = new Store(":memory:");
  let sequence = 0;
  let sent = 0;
  class Message {
    id = `message-${++sequence}`;
    author = { id: "bot" };
    embeds: { footer?: { text: string } }[] = [];
    deleted = false;
    edit(payload: Payload) {
      this.embeds = payload.embeds.map((e) => e.toJSON());
      return Promise.resolve(this);
    }
    delete() {
      this.deleted = true;
      return Promise.resolve(this);
    }
  }
  const channels = new Collection<string, Channel>();
  const created: ChannelOptions[] = [];
  class Channel {
    id = `channel-${++sequence}`;
    type: ChannelType;
    topic?: string;
    overwrites: Overwrite[];
    history = new Collection<string, Message>();
    constructor(options: ChannelOptions) {
      this.type = options.type;
      this.topic = options.topic;
      this.overwrites = options.permissionOverwrites;
    }
    permissionOverwrites = {
      set: (values: Overwrite[]) => {
        this.overwrites = values;
        return Promise.resolve();
      },
    };
    messages = {
      fetch: (input: string | object) =>
        typeof input === "string"
          ? Promise.resolve(this.history.get(input) ?? null)
          : Promise.resolve(this.history),
      delete: (id: string) => {
        this.history.delete(id);
        return Promise.resolve();
      },
    };
    async send(payload: Payload) {
      const message = new Message();
      await message.edit(payload);
      this.history.set(message.id, message);
      sent++;
      return message;
    }
    delete() {
      channels.delete(this.id);
      return Promise.resolve();
    }
  }
  const guild = {
    id: "guild",
    members: {
      fetchMe: () =>
        Promise.resolve({ id: "bot", permissions: { has: () => true } }),
    },
    channels: {
      fetch: (id?: string) =>
        id
          ? Promise.resolve(channels.get(id) ?? null)
          : Promise.resolve(channels),
      create: (options: ChannelOptions) => {
        const channel = new Channel(options);
        channels.set(channel.id, channel);
        created.push(options);
        return Promise.resolve(channel);
      },
    },
  };
  const client = {
    user: { id: "bot" },
    guilds: { fetch: () => Promise.resolve(guild) },
  };
  const rooms = new DiscordRooms(client as unknown as Client, store);
  return {
    store,
    rooms,
    guild: guild as unknown as Guild,
    channels,
    created,
    sent: () => sent,
  };
}
const view = (tag: string) => ({
  embeds: [{ toJSON: () => ({ footer: { text: `Pica · s · ${tag}` } }) }],
});
const channelView = () => ({
  console: view("console"),
  status: view("status"),
  actions: view("actions"),
});

Deno.test("setup and server channels reuse their messages; private room is created with owner-only overwrites", async () => {
  const f = discordFixture();
  try {
    const lobby = await f.rooms.setup(f.guild);
    equal(await f.rooms.setup(f.guild), lobby);
    equal(f.sent(), 1);
    const server = f.store.reserve("alice", "guild", "wild-willow");
    await f.rooms.ensure(server);
    await f.rooms.render(server, channelView());
    await f.rooms.ensure(server);
    await f.rooms.render(server, channelView());
    equal(f.created.length, 3);
    equal(f.sent(), 4);
    const room = f.created[2];
    equal(room.name, "wild-willow");
    equal(room.parent, f.store.setup("guild")!.categoryId);
    deepStrictEqual(room.permissionOverwrites.map((o) => o.id), [
      "guild",
      "bot",
      "alice",
    ]);
    equal(room.permissionOverwrites[0].deny!.includes(P.ViewChannel), true);
    equal(f.store.owner("alice")!.channelId, server.channelId);
    equal(f.store.owner("alice")!.statusId, server.statusId);
  } finally {
    f.store.close();
  }
});

Deno.test("a channel created before a failed database write is recovered by its server marker", async () => {
  const f = discordFixture();
  try {
    await f.rooms.setup(f.guild);
    const server = f.store.reserve("alice", "guild", "wild-willow");
    const save = f.store.save.bind(f.store);
    f.store.save = () => {
      throw new Error("simulated interrupted save");
    };
    await rejects(() => f.rooms.ensure(server));
    f.store.save = save;
    equal(f.store.owner("alice")!.channelId, null);
    const recovered = f.store.owner("alice")!;
    await f.rooms.ensure(recovered);
    equal(f.created.length, 3);
    equal(recovered.channelId, f.store.owner("alice")!.channelId);
  } finally {
    f.store.close();
  }
});

Deno.test("removing a Discord channel can be repaired without changing the server's identity", async () => {
  const f = discordFixture();
  try {
    await f.rooms.setup(f.guild);
    const server = f.store.reserve("alice", "guild", "wild-willow");
    await f.rooms.ensure(server);
    await f.rooms.render(server, channelView());
    const oldChannel = server.channelId!;
    f.channels.delete(oldChannel);
    await f.rooms.ensure(server);
    equal(server.channelId === oldChannel, false);
    equal(server.consoleId, null);
    equal(f.store.owner("alice")!.instanceId, server.instanceId);
  } finally {
    f.store.close();
  }
});

Deno.test("a deleted status message is resent and everything below it is recreated in order", async () => {
  const f = discordFixture();
  try {
    await f.rooms.setup(f.guild);
    const server = f.store.reserve("alice", "guild", "wild-willow");
    await f.rooms.ensure(server);
    await f.rooms.render(server, channelView());
    const channel = f.channels.get(server.channelId!)!;
    const sent = f.sent();
    const oldActions = server.actionsId!;
    channel.history.get(server.statusId!)!.deleted = true;
    channel.history.delete(server.statusId!);
    await f.rooms.render(server, channelView());
    // Status and actions are resent; the console message is only edited.
    equal(f.sent(), sent + 2);
    // The orphaned actions message is deleted, not left with live buttons.
    equal(channel.history.has(oldActions), false);
    const ids = [...channel.history.keys()];
    equal(
      ids.indexOf(server.consoleId!) < ids.indexOf(server.statusId!) &&
        ids.indexOf(server.statusId!) < ids.indexOf(server.actionsId!),
      true,
    );
  } finally {
    f.store.close();
  }
});
