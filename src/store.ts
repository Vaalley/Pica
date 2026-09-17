import { DatabaseSync } from "node:sqlite";
import { InputError } from "./api.ts";

export type Server = {
  ownerId: string;
  guildId: string;
  instanceId: string;
  channelId: string | null;
  consoleId: string | null;
  statusId: string | null;
  actionsId: string | null;
  hostname: string | null;
  software: string | null;
  phase: "provisioning" | "ready" | "deleting" | "deleted";
};
export type Setup = {
  guildId: string;
  lobbyId: string | null;
  categoryId: string | null;
  messageId: string | null;
};

/** Durable ownership is the authority; Discord channel names are never identity. */
export class Store {
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS setups (
        guildId TEXT PRIMARY KEY, lobbyId TEXT, categoryId TEXT, messageId TEXT
      );
    `);
    const columns = this.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='servers'",
      ).all().length
      ? (this.db.prepare("PRAGMA table_info(servers)").all() as {
        name: string;
      }[]).map((c) => c.name)
      : [];
    if (!columns.length) {
      this.db.exec(`
        CREATE TABLE servers (
          ownerId TEXT PRIMARY KEY, guildId TEXT NOT NULL,
          instanceId TEXT NOT NULL UNIQUE, channelId TEXT UNIQUE,
          consoleId TEXT, statusId TEXT, actionsId TEXT,
          hostname TEXT, software TEXT,
          phase TEXT NOT NULL CHECK (phase IN ('provisioning','ready','deleting','deleted'))
        );
      `);
    } else if (!columns.includes("consoleId")) {
      this.db.exec(`
        BEGIN;
        ALTER TABLE servers RENAME TO servers_old;
        CREATE TABLE servers (
          ownerId TEXT PRIMARY KEY, guildId TEXT NOT NULL,
          instanceId TEXT NOT NULL UNIQUE, channelId TEXT UNIQUE,
          consoleId TEXT, statusId TEXT, actionsId TEXT,
          hostname TEXT, software TEXT,
          phase TEXT NOT NULL CHECK (phase IN ('provisioning','ready','deleting','deleted'))
        );
        INSERT INTO servers (ownerId, guildId, instanceId, channelId, hostname, phase)
          SELECT ownerId, guildId, instanceId, channelId, hostname, phase FROM servers_old;
        DROP TABLE servers_old;
        COMMIT;
      `);
    }
  }
  owner(ownerId: string): Server | undefined {
    return this.db.prepare("SELECT * FROM servers WHERE ownerId = ?").get(
      ownerId,
    ) as Server | undefined;
  }
  all(): Server[] {
    return this.db.prepare("SELECT * FROM servers").all() as Server[];
  }
  reserve(ownerId: string, guildId: string, instanceId: string): Server {
    const existing = this.owner(ownerId);
    if (existing) return existing;
    this.db.prepare(
      "INSERT INTO servers (ownerId, guildId, instanceId, phase) VALUES (?, ?, ?, 'provisioning')",
    )
      .run(ownerId, guildId, instanceId);
    return this.owner(ownerId)!;
  }
  /** Drop a provisioning reservation so a fresh instance ID can be tried. */
  release(server: Server): void {
    this.db.prepare(
      "DELETE FROM servers WHERE ownerId=? AND instanceId=? AND phase='provisioning'",
    ).run(server.ownerId, server.instanceId);
  }
  save(server: Server): void {
    this.db.prepare(
      `UPDATE servers SET channelId=?, consoleId=?, statusId=?, actionsId=?,
       hostname=?, software=?, phase=? WHERE ownerId=? AND instanceId=?`,
    )
      .run(
        server.channelId,
        server.consoleId,
        server.statusId,
        server.actionsId,
        server.hostname,
        server.software,
        server.phase,
        server.ownerId,
        server.instanceId,
      );
  }
  remove(server: Server): void {
    this.db.prepare(
      "DELETE FROM servers WHERE ownerId=? AND instanceId=? AND phase='deleted'",
    )
      .run(server.ownerId, server.instanceId);
  }
  owned(guildId: string, ownerId: string, channelId: string): Server {
    const server = this.owner(ownerId);
    if (
      !server || server.guildId !== guildId || server.channelId !== channelId
    ) {
      throw new InputError(
        "Use your own private server channel to manage your Minecraft server.",
      );
    }
    return server;
  }
  setup(guildId: string): Setup | undefined {
    return this.db.prepare("SELECT * FROM setups WHERE guildId=?").get(
      guildId,
    ) as Setup | undefined;
  }
  saveSetup(setup: Setup): void {
    this.db.prepare(
      `INSERT INTO setups (guildId,lobbyId,categoryId,messageId) VALUES (?,?,?,?)
      ON CONFLICT(guildId) DO UPDATE SET lobbyId=excluded.lobbyId,categoryId=excluded.categoryId,messageId=excluded.messageId`,
    )
      .run(setup.guildId, setup.lobbyId, setup.categoryId, setup.messageId);
  }
  close(): void {
    this.db.close();
  }
}
