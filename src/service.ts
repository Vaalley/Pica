import { InputError, type Instance, PicaApi, PicaApiError } from "./api.ts";
import { OperationLocks } from "./common.ts";
import { type Server, Store } from "./store.ts";

export interface Rooms {
  ensure(server: Server): Promise<void>;
  panel(server: Server, instance?: Instance, notice?: string): Promise<void>;
  remove(server: Server): Promise<void>;
}

export class Servers {
  readonly locks = new OperationLocks();
  constructor(
    readonly store: Store,
    readonly api: PicaApi,
    readonly rooms: Rooms,
  ) {}

  async create(
    guildId: string,
    ownerId: string,
    eula: string,
  ): Promise<Server> {
    if (eula.trim() !== "ACCEPT") {
      throw new InputError(
        "Type ACCEPT to accept the Minecraft EULA and create your server.",
      );
    }
    return await this.locks.run(ownerId, async () => {
      if (!this.store.setup(guildId)?.categoryId) {
        throw new InputError("An administrator needs to run /setup first.");
      }
      const previous = this.store.owner(ownerId);
      if (previous && previous.guildId !== guildId) {
        throw new InputError(
          "You already own a Pica server in another Discord server.",
        );
      }
      const server = previous ?? this.store.reserve(ownerId, guildId);
      await this.rooms.ensure(server);
      await this.rooms.panel(server);
      if (server.phase !== "provisioning") return server;
      // An interrupted create may already have succeeded remotely. Never allocate
      // another ID or forget ownership after an ambiguous failure.
      let instance: Instance | undefined;
      if (previous) {
        try {
          instance = await this.api.instance(server.instanceId, "status");
        } catch (error) {
          if (!(error instanceof PicaApiError && error.status === 404)) {
            throw error;
          }
        }
      }
      instance ??= await this.api.create(server.instanceId, true);
      server.phase = "ready";
      server.hostname = instance.hostname;
      this.store.save(server);
      await this.rooms.panel(
        server,
        instance,
        "Your server is ready. Join using the address below.",
      );
      return server;
    });
  }

  async action(
    server: Server,
    action: "status" | "start" | "stop" | "restart",
  ): Promise<Instance> {
    return await this.locks.run(server.ownerId, async () => {
      this.ready(server);
      const instance = await this.api.instance(server.instanceId, action);
      server.hostname = instance.hostname;
      this.store.save(server);
      // Discord failing to refresh must not misreport a successful backend action.
      try {
        await this.rooms.panel(
          server,
          instance,
          action === "status"
            ? "Server details refreshed."
            : `${action[0].toUpperCase()}${action.slice(1)} completed.`,
        );
      } catch {
        console.error(
          "Server action succeeded but its Discord panel could not refresh.",
        );
      }
      return instance;
    });
  }

  ready(server: Server): void {
    const current = this.store.owner(server.ownerId);
    if (
      !current || current.instanceId !== server.instanceId ||
      current.phase !== "ready"
    ) {
      throw new InputError(
        "Your server is not ready for this action. Use the channel panel to finish setup or deletion.",
      );
    }
  }

  async delete(server: Server, confirmation: string): Promise<void> {
    if (confirmation !== "DELETE") {
      throw new InputError(
        "Type DELETE to confirm permanently deleting your server and all its files.",
      );
    }
    await this.locks.run(server.ownerId, async () => {
      if (server.phase === "provisioning") {
        throw new InputError("Finish server setup before deleting it.");
      }
      const retry = server.phase === "deleting";
      if (server.phase !== "deleted") {
        server.phase = "deleting";
        this.store.save(server);
        try {
          await this.api.instance(server.instanceId, "delete");
        } catch (error) {
          // A retry can observe 404 after a successful delete whose response was lost.
          if (
            !(retry && error instanceof PicaApiError && error.status === 404)
          ) {
            if (
              error instanceof PicaApiError &&
              [400, 401, 409, 503].includes(error.status)
            ) {
              server.phase = "ready";
              this.store.save(server);
            }
            throw error;
          }
        }
        server.phase = "deleted";
        this.store.save(server);
      }
      await this.rooms.remove(server);
      this.store.remove(server);
    });
  }
}
