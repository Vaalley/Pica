import { InputError, type Instance, PicaApi, PicaApiError } from "./api.ts";
import { errorMessage, OperationLocks } from "./common.ts";
import { type Server, Store } from "./store.ts";
import { actionsMessage, consoleMessage, statusMessage } from "./ui.ts";
import { instanceName } from "./words.ts";

export const CHANNEL_TTL_MS = 60 * 60 * 1000;
export const TICK_MS = 60 * 1000;

export type ChannelView = {
  console?: unknown;
  status?: unknown;
  actions?: unknown;
};
export interface Rooms {
  ensure(server: Server): Promise<void>;
  render(server: Server, view: ChannelView): Promise<void>;
  remove(server: Server): Promise<void>;
}
export interface Sessions {
  revoke(ownerId: string): void;
}

export class Servers {
  readonly locks = new OperationLocks();
  sessions?: Sessions;
  private snapshots = new Map<string, Instance>();
  private online = new Map<string, boolean>();
  private activity = new Map<string, number>();
  constructor(
    readonly store: Store,
    readonly api: PicaApi,
    readonly rooms: Rooms,
    private now = Date.now,
  ) {}

  touch(ownerId: string): void {
    this.activity.set(ownerId, this.now());
  }
  private idle(server: Server): number {
    return this.now() - (this.activity.get(server.ownerId) ?? 0);
  }

  /** Channels expire one hour after the owner's last interaction. */
  async sweep(): Promise<void> {
    for (const server of this.store.all()) {
      if (!server.channelId || this.idle(server) < CHANNEL_TTL_MS) continue;
      if (this.locks.has(server.ownerId)) continue;
      try {
        await this.rooms.remove(server);
      } catch {
        console.error("Could not delete an expired server channel.");
        continue;
      }
      server.channelId = null;
      server.consoleId = server.statusId = server.actionsId = null;
      this.store.save(server);
      this.sessions?.revoke(server.ownerId);
    }
  }

  /** Refresh the console and status messages for every live channel. */
  async tick(): Promise<void> {
    const servers = this.store.all().filter((server) =>
      server.channelId && server.phase === "ready" &&
      this.idle(server) < CHANNEL_TTL_MS && !this.locks.has(server.ownerId)
    );
    const results = await Promise.allSettled(
      servers.map((server) => this.render(server, undefined, false, 15_000)),
    );
    for (const result of results) {
      if (result.status === "rejected") {
        console.error("Could not refresh a server channel.");
      }
    }
  }

  private maintaining = false;
  /** One maintenance pass; skipped entirely if the previous one is still running. */
  async maintain(): Promise<void> {
    if (this.maintaining) return;
    this.maintaining = true;
    try {
      await this.tick();
      await this.sweep();
    } finally {
      this.maintaining = false;
    }
  }

  /** Prime activity for channels that already exist when the bot starts. */
  resume(): void {
    for (const server of this.store.all()) {
      if (server.channelId) this.touch(server.ownerId);
    }
  }

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
        throw new InputError(
          "An administrator needs to finish Pica setup first.",
        );
      }
      const previous = this.store.owner(ownerId);
      if (previous && previous.guildId !== guildId) {
        throw new InputError(
          "You already own a Pica server in another Discord server.",
        );
      }
      const server = previous ?? this.store.reserve(
        ownerId,
        guildId,
        instanceName(),
      );
      this.touch(ownerId);
      await this.rooms.ensure(server);
      if (server.phase !== "provisioning") {
        await this.render(server);
        return server;
      }
      await this.paint(
        server,
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
        if (!instance) {
          for (let attempt = 0; attempt < 4 && !instance; attempt++) {
            try {
              instance = await this.api.create(server.instanceId, true);
            } catch (error) {
              // A pretty name can collide with an instance made outside the bot.
              if (
                !previous && attempt < 3 && error instanceof PicaApiError &&
                [400, 409].includes(error.status)
              ) {
                const retry = instanceName(attempt + 2);
                this.store.release(server);
                server.instanceId = retry;
                this.store.reserve(ownerId, guildId, retry);
                continue;
              }
              throw error;
            }
          }
        }
        server.phase = "ready";
        server.hostname = instance!.hostname;
        this.store.save(server);
        this.snapshots.set(server.instanceId, instance!);
        await this.render(server);
        return server;
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }

  /** "Open existing" brings back an expired channel for the same server. */
  async open(guildId: string, ownerId: string): Promise<Server> {
    return await this.locks.run(ownerId, async () => {
      const server = this.store.owner(ownerId);
      if (!server || server.guildId !== guildId) {
        throw new InputError(
          "You don't have a Pica server yet. Use Create server first.",
        );
      }
      this.touch(ownerId);
      await this.rooms.ensure(server);
      await this.render(server);
      return server;
    });
  }

  async action(
    server: Server,
    action: "start" | "stop" | "restart",
  ): Promise<Instance> {
    return await this.locks.run(server.ownerId, async () => {
      this.ready(server);
      this.touch(server.ownerId);
      const progress = {
        start: "Starting Minecraft…",
        stop: "Stopping Minecraft and disconnecting players…",
        restart: "Restarting Minecraft…",
      };
      await this.paint(server, progress[action], true);
      try {
        const instance = await this.api.instance(server.instanceId, action);
        this.snapshots.set(server.instanceId, instance);
        this.online.set(
          server.instanceId,
          action === "start" || action === "restart"
            ? true
            : action === "stop"
            ? false
            : this.online.get(server.instanceId) ?? true,
        );
        await this.paint(server);
        return instance;
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }

  async command(server: Server, command: string): Promise<string> {
    return await this.locks.run(server.ownerId, async () => {
      this.ready(server);
      this.touch(server.ownerId);
      const result = await this.api.run(server.instanceId, command);
      await this.paint(server);
      return result.response || "Command completed with no output.";
    });
  }

  /** Bot-downloaded file (software JAR, mod, plugin) written through the fs API. */
  async installFile(
    server: Server,
    path: string,
    data: Uint8Array,
    filename: string,
    notice: string,
    software?: string,
  ): Promise<void> {
    await this.locks.run(server.ownerId, async () => {
      this.ready(server);
      this.touch(server.ownerId);
      await this.paint(server, `Installing ${filename}…`, true);
      try {
        const result = await this.api.write(
          server.instanceId,
          path,
          new Blob([new Uint8Array(data)]),
          filename,
        );
        if (software) {
          server.software = software;
          this.store.save(server);
        }
        await this.paint(
          server,
          `${notice}${
            result.restartRequired || path === "boot.jar"
              ? " Restart to apply it."
              : ""
          }`,
        );
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }

  /** Mocked until the backend exposes a hostname route: stored locally only. */
  async setHostname(server: Server, subdomain: string): Promise<void> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(subdomain)) {
      throw new InputError(
        "Subdomain must be 1–32 lowercase letters, digits, or internal hyphens.",
      );
    }
    await this.locks.run(server.ownerId, async () => {
      this.ready(server);
      this.touch(server.ownerId);
      const domain = (server.hostname ?? "").split(".").slice(1).join(".");
      server.hostname = domain ? `${subdomain}.${domain}` : subdomain;
      this.store.save(server);
      await this.paint(server);
    });
  }

  /** Fetch fresh state and repaint the three channel messages. */
  async render(
    server: Server,
    notice?: string,
    busy = false,
    timeoutMs?: number,
  ): Promise<void> {
    let instance = this.snapshots.get(server.instanceId);
    let lines: string[] | undefined;
    if (server.phase === "ready" && !busy) {
      try {
        instance = await this.api.instance(
          server.instanceId,
          "status",
          timeoutMs,
        );
        // server.hostname is owner-set (mocked Change IP); never overwrite it here.
        this.snapshots.set(server.instanceId, instance);
      } catch {
        console.error("Could not refresh server details.");
      }
      try {
        lines = (await this.api.tail(server.instanceId, timeoutMs)).lines;
        this.online.set(server.instanceId, true);
      } catch (error) {
        if (error instanceof PicaApiError && error.status === 502) {
          this.online.set(server.instanceId, false);
          lines = [];
        } else {
          console.error("Could not read the server console.");
        }
      }
    }
    await this.rooms.render(server, {
      console: consoleMessage(server, lines),
      status: statusMessage(
        server,
        instance,
        this.online.get(server.instanceId),
        notice,
        busy,
      ),
      actions: actionsMessage(server, busy),
    });
  }

  /** Best-effort notice: a Discord blip must not mask the real outcome. */
  async paint(server: Server, notice?: string, busy = false): Promise<void> {
    try {
      await this.render(server, notice, busy);
    } catch {
      console.error("Could not refresh the server's Discord messages.");
    }
  }

  ready(server: Server): void {
    const current = this.store.owner(server.ownerId);
    if (
      !current || current.instanceId !== server.instanceId ||
      current.phase !== "ready"
    ) {
      throw new InputError(
        "Your server is not ready for this action. Finish setup or deletion first.",
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
        this.online.delete(server.instanceId);
        this.activity.delete(server.ownerId);
        this.sessions?.revoke(server.ownerId);
      } catch (error) {
        await this.paint(server, errorMessage(error));
        throw error;
      }
    });
  }
}
