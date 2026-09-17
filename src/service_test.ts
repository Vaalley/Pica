import {
  deepStrictEqual,
  equal,
  match,
  rejects,
  throws,
} from "node:assert/strict";
import { InputError, PicaApiError } from "./api.ts";
import { CHANNEL_TTL_MS, Servers } from "./service.ts";
import { Store } from "./store.ts";
import { fixture } from "./test_helpers.ts";

Deno.test("a member gets one durable server and private channel; repeated clicks reuse both", async () => {
  const f = fixture();
  try {
    const first = await f.service.create("guild", "alice", "ACCEPT");
    const again = await f.service.create("guild", "alice", "ACCEPT");
    equal(first.instanceId, again.instanceId);
    equal(first.channelId, again.channelId);
    equal(f.rooms.created, 1);
    equal(f.requests.filter((r) => r === "/instance/create").length, 1);
    equal(f.store.owner("alice")?.phase, "ready");
    match(first.instanceId, /^[a-z]+-[a-z]+$/);
  } finally {
    f.store.close();
  }
});

Deno.test("ownership binds user, guild and channel and never accepts another user's channel", async () => {
  const f = fixture();
  try {
    const alice = await f.service.create("guild", "alice", "ACCEPT");
    const bob = await f.service.create("guild", "bob", "ACCEPT");
    throws(() => f.store.owned("guild", "bob", alice.channelId!), InputError);
    throws(() => f.store.owned("other", "alice", alice.channelId!), InputError);
    equal(
      f.store.owned("guild", "bob", bob.channelId!).instanceId,
      bob.instanceId,
    );
    f.store.saveSetup({
      guildId: "other",
      lobbyId: "lobby2",
      categoryId: "cat2",
      messageId: "m2",
    });
    await rejects(
      () => f.service.create("other", "alice", "ACCEPT"),
      InputError,
    );
    equal(f.remote.size, 2);
  } finally {
    f.store.close();
  }
});

Deno.test("EULA rejection creates no ownership, channel, or backend instance", async () => {
  const f = fixture();
  try {
    await rejects(() => f.service.create("guild", "alice", "no"), InputError);
    equal(f.store.owner("alice"), undefined);
    equal(f.rooms.created, 0);
    equal(f.requests.length, 0);
  } finally {
    f.store.close();
  }
});

Deno.test("concurrent create clicks cannot provision two instances", async () => {
  const f = fixture();
  let release!: () => void;
  const ensure = f.rooms.ensure;
  f.rooms.ensure = async (s) => {
    await ensure(s);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  try {
    const pending = f.service.create("guild", "alice", "ACCEPT");
    await rejects(
      () => f.service.create("guild", "alice", "ACCEPT"),
      InputError,
    );
    release();
    await pending;
    equal(f.remote.size, 1);
  } finally {
    f.store.close();
  }
});

Deno.test("a timed-out create resumes the same remote instance after bot restart", async () => {
  const f = fixture();
  const create = f.api.create.bind(f.api);
  f.api.create = async (id, accepted) => {
    await create(id, accepted);
    throw new DOMException("lost response", "TimeoutError");
  };
  try {
    await rejects(() => f.service.create("guild", "alice", "ACCEPT"));
    const id = f.store.owner("alice")!.instanceId;
    equal(f.store.owner("alice")!.phase, "provisioning");
    const restarted = new Servers(f.store, f.api, f.rooms);
    equal((await restarted.create("guild", "alice", "ACCEPT")).instanceId, id);
    equal(f.remote.size, 1);
    equal(f.rooms.created, 1);
    equal(f.requests.filter((r) => r === "/instance/create").length, 1);
  } finally {
    f.store.close();
  }
});

Deno.test("capacity failure keeps the channel and reuses its reserved ID on retry", async () => {
  const f = fixture();
  const create = f.api.create.bind(f.api);
  f.api.create = () => Promise.reject(new PicaApiError(503, "busy"));
  try {
    await rejects(
      () => f.service.create("guild", "alice", "ACCEPT"),
      PicaApiError,
    );
    const pending = f.store.owner("alice")!;
    f.api.create = create;
    const ready = await f.service.create("guild", "alice", "ACCEPT");
    equal(pending.instanceId, ready.instanceId);
    equal(pending.channelId, ready.channelId);
  } finally {
    f.store.close();
  }
});

Deno.test("channel render failure never allocates a replacement server", async () => {
  const f = fixture();
  try {
    await f.service.create("guild", "alice", "ACCEPT");
    f.rooms.failRender = true;
    await rejects(() => f.service.create("guild", "alice", "ACCEPT"));
    f.rooms.failRender = false;
    await f.service.create("guild", "alice", "ACCEPT");
    equal(f.remote.size, 1);
  } finally {
    f.store.close();
  }
});

Deno.test("deletion preserves ownership on conflict and resumes channel cleanup without repeating API deletion", async () => {
  const f = fixture();
  try {
    const server = await f.service.create("guild", "alice", "ACCEPT");
    await rejects(() => f.service.delete(server, "wrong"), InputError);
    equal(f.remote.size, 1);
    const call = f.api.instance.bind(f.api);
    f.api.instance = () =>
      Promise.reject(new PicaApiError(409, "players connected"));
    await rejects(() => f.service.delete(server, "DELETE"), PicaApiError);
    equal(f.store.owner("alice")!.phase, "ready");
    f.api.instance = call;
    f.rooms.failRemove = true;
    await rejects(() => f.service.delete(server, "DELETE"));
    equal(f.store.owner("alice")!.phase, "deleted");
    equal(f.remote.size, 0);
    f.rooms.failRemove = false;
    await f.service.delete(f.store.owner("alice")!, "DELETE");
    equal(f.store.owner("alice"), undefined);
    equal(f.requests.filter((r) => r.endsWith("/delete")).length, 1);
  } finally {
    f.store.close();
  }
});

Deno.test("an idle channel expires after one hour and Open existing restores it", async () => {
  let now = 1_000_000;
  const f = fixture();
  const service = new Servers(f.store, f.api, f.rooms, () => now);
  try {
    const server = await service.create("guild", "alice", "ACCEPT");
    equal(server.channelId, "channel-alice");
    now += CHANNEL_TTL_MS + 1;
    await service.sweep();
    equal(f.rooms.removed, 1);
    equal(f.store.owner("alice")!.channelId, null);
    const restored = await service.open("guild", "alice");
    equal(restored.channelId, "channel-alice");
    equal(f.rooms.created, 2);
    equal(f.remote.size, 1);
    await rejects(() => service.open("guild", "bob"), InputError);
  } finally {
    f.store.close();
  }
});

Deno.test("activity resets the expiry clock and tick skips busy or expired channels", async () => {
  let now = 1_000_000;
  const f = fixture();
  const service = new Servers(f.store, f.api, f.rooms, () => now);
  try {
    await service.create("guild", "alice", "ACCEPT");
    now += CHANNEL_TTL_MS - 1;
    service.touch("alice");
    now += 2;
    await service.sweep();
    equal(f.rooms.removed, 0);
    const views = f.rooms.views.length;
    await service.tick();
    equal(f.rooms.views.length > views, true);
    now += CHANNEL_TTL_MS + 1;
    const before = f.rooms.views.length;
    await service.tick();
    equal(f.rooms.views.length, before);
  } finally {
    f.store.close();
  }
});

Deno.test("setHostname validates and persists Pica's returned hostname", async () => {
  const f = fixture();
  try {
    const server = await f.service.create("guild", "alice", "ACCEPT");
    await f.service.setHostname(server, "wild-willow");
    equal(f.store.owner("alice")!.hostname, "wild-willow.pica.host");
    equal(
      f.requests.includes(`/instance/${server.instanceId}/change-subdomain`),
      true,
    );
    await rejects(
      () => f.service.setHostname(server, "Bad_Name"),
      InputError,
    );
  } finally {
    f.store.close();
  }
});

Deno.test("ownership and setup survive closing and reopening the SQLite database", () => {
  Deno.mkdirSync("data", { recursive: true });
  const path = `data/test-${crypto.randomUUID()}.sqlite`;
  let db: Store | undefined;
  try {
    db = new Store(path);
    const server = db.reserve("alice", "guild", "wild-willow");
    server.channelId = "private-channel";
    server.phase = "ready";
    db.save(server);
    db.saveSetup({
      guildId: "guild",
      lobbyId: "lobby",
      categoryId: "category",
      messageId: "welcome",
    });
    db.close();
    db = new Store(path);
    deepStrictEqual(
      { ...db.owned("guild", "alice", "private-channel") },
      { ...server },
    );
    equal(db.setup("guild")!.messageId, "welcome");
  } finally {
    db?.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        Deno.removeSync(path + suffix);
      } catch (error) {
        equal(error instanceof Deno.errors.NotFound, true);
      }
    }
  }
});
