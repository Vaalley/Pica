import { InputError } from "./api.ts";
import { type Server } from "./store.ts";

type Confirmation = {
  server: Server;
  action: "restart" | "stop" | "delete";
  expires: number;
};
export class Confirmations {
  private pending = new Map<string, Confirmation>();
  constructor(private now = Date.now) {}
  issue(server: Server, action: Confirmation["action"]): string {
    for (const [token, value] of this.pending) {
      if (
        value.expires < this.now() || value.server.ownerId === server.ownerId
      ) this.pending.delete(token);
    }
    const token = crypto.randomUUID();
    this.pending.set(token, {
      server: { ...server },
      action,
      expires: this.now() + 120_000,
    });
    return token;
  }
  consume(token: string, server: Server): Confirmation["action"] {
    const value = this.pending.get(token);
    if (!value || value.expires < this.now()) {
      this.pending.delete(token);
      throw new InputError(
        "This confirmation expired. Choose the action again from your server panel.",
      );
    }
    if (
      value.server.ownerId !== server.ownerId ||
      value.server.guildId !== server.guildId ||
      value.server.channelId !== server.channelId ||
      value.server.instanceId !== server.instanceId
    ) {
      throw new InputError("This confirmation belongs to a different server.");
    }
    this.pending.delete(token);
    return value.action;
  }
}
