import { type Instance, PicaApi } from "./api.ts";
import { type Rooms, Servers } from "./service.ts";
import { Store } from "./store.ts";

export const instance = (id: string): Instance => ({
  id,
  hostname: `${id}.pica.host`,
  memoryMiB: 3072,
  cpus: 2,
  connections: 0,
  eulaAccepted: true,
  usedBytes: 0,
  storageBlocked: false,
  restartRequired: false,
  storageLimitBytes: 10 * 1024 ** 3,
  diskBytes: 15 * 1024 ** 3,
});
export function fixture() {
  const store = new Store(":memory:");
  store.saveSetup({
    guildId: "guild",
    lobbyId: "lobby",
    categoryId: "category",
    messageId: "welcome",
  });
  const remote = new Map<string, Instance>();
  const requests: string[] = [];
  const rooms: Rooms & {
    created: number;
    removed: number;
    failPanel: boolean;
    failRemove: boolean;
  } = {
    created: 0,
    removed: 0,
    failPanel: false,
    failRemove: false,
    ensure(server) {
      if (!server.channelId) {
        server.channelId = `channel-${server.ownerId}`;
        rooms.created++;
        store.save(server);
      }
      return Promise.resolve();
    },
    panel() {
      return rooms.failPanel
        ? Promise.reject(new Error("Discord unavailable"))
        : Promise.resolve();
    },
    remove() {
      rooms.removed++;
      return rooms.failRemove
        ? Promise.reject(new Error("Discord unavailable"))
        : Promise.resolve();
    },
  };
  const api = new PicaApi(
    "http://127.0.0.1:8091",
    "s".repeat(32),
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path === "/instance/create") {
        const body = JSON.parse(String(init?.body));
        remote.set(body.id, instance(body.id));
        return Response.json(remote.get(body.id));
      }
      const id = path.split("/")[2];
      const value = remote.get(id);
      if (!value) return Response.json({ error: "missing" }, { status: 404 });
      if (path.endsWith("/delete")) remote.delete(id);
      await Promise.resolve();
      return Response.json(value);
    },
  );
  const service = new Servers(store, api, rooms);
  return { store, api, rooms, service, remote, requests };
}
