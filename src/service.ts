import { InputError, type Instance, PicaApi, PicaApiError } from "./api.ts";
import { errorMessage, OperationLocks } from "./common.ts";
import { type Server, Store } from "./store.ts";

export interface Rooms {
  ensure(server: Server): Promise<void>;
  panel(
    server: Server,
    instance?: Instance,
    notice?: string,
    busy?: boolean,
  ): Promise<void>;
  remove(server: Server): Promise<void>;
}

export class Servers {
  readonly locks = new OperationLocks();
  private snapshots = new Map<string, Instance>();
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
      if (server.phase !== "provisioning") {
        const instance = server.phase === "ready"
          ? await this.api.instance(server.instanceId, "status")
          : undefined;
        if (instance) this.snapshots.set(server.instanceId, instance);
        await this.rooms.panel(server, instance);
        return server;
      }
      await this.rooms.panel(
        server,
        undefined,
        "Creating your Minecraft server. This can take up to three minutes.",
        true,
      );
      try {
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
        this.snapshots.set(server.instanceId, instance);
        await this.rooms.panel(
          server,
          instance,
          "Your server is ready. Join using the address below.",
        );
        return server;
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }

  async action(
    server: Server,
    action: "status" | "start" | "stop" | "restart",
  ): Promise<Instance> {
    return await this.locks.run(server.ownerId, async () => {
      this.ready(server);
      const progress = {
        status: "Refreshing server details…",
        start: "Starting Minecraft…",
        stop: "Stopping Minecraft and disconnecting players…",
        restart: "Restarting Minecraft…",
      };
      await this.paint(server, progress[action], true);
      try {
        const instance = await this.api.instance(server.instanceId, action);
        server.hostname = instance.hostname;
        this.store.save(server);
        this.snapshots.set(server.instanceId, instance);
        const completed = {
          status: "Server details refreshed.",
          start: "Minecraft started. You can join now.",
          stop:
            "Minecraft stopped. Click Start when you’re ready to play again.",
          restart: "Minecraft restarted. You can rejoin now.",
        };
        await this.paint(server, completed[action]);
        return instance;
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }

  /** Panel delivery must not turn a successful backend mutation into a failure. */
  async paint(server: Server, notice?: string, busy = false): Promise<void> {
    try {
      await this.rooms.panel(
        server,
        this.snapshots.get(server.instanceId),
        notice,
        busy,
      );
    } catch {
      console.error("Could not refresh the server's Discord panel.");
    }
  }

  async refreshPanel(server: Server, notice?: string): Promise<void> {
    try {
      this.snapshots.set(
        server.instanceId,
        await this.api.instance(server.instanceId, "status"),
      );
    } catch {
      console.error("Could not refresh server details after an action.");
    }
    await this.paint(server, notice);
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
      try {
        if (server.phase !== "deleted") {
          server.phase = "deleting";
          this.store.save(server);
          await this.paint(
            server,
            "Deleting your Minecraft server and disconnecting players…",
            true,
          );
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
        this.snapshots.delete(server.instanceId);
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }
}
