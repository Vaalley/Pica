import {
  ChannelType,
  type Client,
  Collection,
  type Guild,
  type Message,
  OverwriteType,
  PermissionFlagsBits as P,
  type TextChannel,
} from "discord.js";
import { InputError } from "./api.ts";
import { OperationLocks } from "./common.ts";
import { type ChannelView, type Rooms } from "./service.ts";
import { type Server, Store } from "./store.ts";
import { lobbyPanel } from "./ui.ts";

export function privateOverwrites(
  guildId: string,
  botId: string,
  ownerId?: string,
) {
  const overwrites = [
    {
      id: guildId,
      type: OverwriteType.Role,
      allow: [] as bigint[],
      deny: [P.ViewChannel],
    },
    {
      id: botId,
      type: OverwriteType.Member,
      allow: [
        P.ViewChannel,
        P.SendMessages,
        P.ReadMessageHistory,
        P.AttachFiles,
        P.EmbedLinks,
        P.ManageChannels,
        P.ManageRoles,
      ],
      deny: [] as bigint[],
    },
  ];
  if (ownerId) {
    overwrites.push({
      id: ownerId,
      type: OverwriteType.Member,
      allow: [
        P.ViewChannel,
        P.SendMessages,
        P.ReadMessageHistory,
        P.AttachFiles,
        P.EmbedLinks,
      ],
      deny: [
        P.ManageChannels,
        P.ManageRoles,
        P.CreatePublicThreads,
        P.CreatePrivateThreads,
      ],
    });
  }
  return overwrites;
}
async function missingAsNull<T>(
  operation: () => Promise<T>,
): Promise<T | null> {
  try {
    return await operation();
  } catch (error) {
    if (
      typeof error === "object" && error !== null && "code" in error &&
      [10003, 10008].includes(Number(error.code))
    ) return null;
    throw error;
  }
}

export class DiscordRooms implements Rooms {
  private locks = new OperationLocks();
  constructor(private client: Client, private store: Store) {}

  async setup(guild: Guild): Promise<string> {
    return await this.locks.run(guild.id, async () => {
      const bot = await guild.members.fetchMe();
      if (
        !bot.permissions.has([
          P.ManageChannels,
          P.ManageRoles,
          P.ViewChannel,
          P.SendMessages,
          P.ReadMessageHistory,
          P.AttachFiles,
          P.EmbedLinks,
        ])
      ) {
        throw new InputError(
          "The bot needs Manage Channels, Manage Roles, View Channels, Send Messages, Read Message History, Attach Files, and Embed Links to set up private server channels.",
        );
      }
      const setup = this.store.setup(guild.id) ??
        { guildId: guild.id, lobbyId: null, categoryId: null, messageId: null };
      let category = setup.categoryId
        ? await missingAsNull(() => guild.channels.fetch(setup.categoryId!))
        : null;
      if (category && category.type !== ChannelType.GuildCategory) {
        throw new InputError(
          "The saved server category is not a category. Contact the bot operator.",
        );
      }
      if (!category) {
        category = await guild.channels.create({
          name: "Minecraft servers",
          type: ChannelType.GuildCategory,
          permissionOverwrites: privateOverwrites(guild.id, bot.id),
        });
        setup.categoryId = category.id;
        this.store.saveSetup(setup);
      }
      let lobby = setup.lobbyId
        ? await missingAsNull(() => guild.channels.fetch(setup.lobbyId!))
        : null;
      if (lobby && lobby.type !== ChannelType.GuildText) {
        throw new InputError(
          "The saved create channel is not a text channel. Contact the bot operator.",
        );
      }
      if (!lobby) {
        lobby = await guild.channels.create({
          name: "create-a-server",
          type: ChannelType.GuildText,
          topic: "Pica · Create your personal Minecraft server",
          permissionOverwrites: [
            {
              id: guild.id,
              allow: [P.ViewChannel, P.ReadMessageHistory],
              deny: [
                P.SendMessages,
                P.CreatePublicThreads,
                P.CreatePrivateThreads,
                P.SendMessagesInThreads,
              ],
            },
            {
              id: bot.id,
              allow: [
                P.ViewChannel,
                P.SendMessages,
                P.ReadMessageHistory,
                P.EmbedLinks,
              ],
            },
          ],
        });
        setup.lobbyId = lobby.id;
        setup.messageId = null;
        this.store.saveSetup(setup);
      }
      if (lobby.type !== ChannelType.GuildText) {
        throw new InputError("A text channel is required.");
      }
      let message = setup.messageId
        ? await missingAsNull(() => lobby.messages.fetch(setup.messageId!))
        : null;
      if (!message) {
        message = (await lobby.messages.fetch({ limit: 100 })).find((m) =>
          m.author.id === bot.id && m.components.some((row) =>
            "components" in row && row.components.some((c) =>
              "customId" in c && c.customId === "pica:create"
            )
          )
        ) ?? null;
      }
      if (message) await message.edit(lobbyPanel());
      else message = await lobby.send(lobbyPanel());
      setup.messageId = message.id;
      this.store.saveSetup(setup);
      return lobby.id;
    });
  }

  async ensure(server: Server): Promise<void> {
    const guild = await this.client.guilds.fetch(server.guildId);
    const setup = this.store.setup(server.guildId);
    if (!setup?.categoryId) {
      throw new InputError("Ask an administrator to finish Pica setup first.");
    }
    const category = await missingAsNull(() =>
      guild.channels.fetch(setup.categoryId!)
    );
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new InputError(
        "The server category was removed. Ask an administrator to restart the bot.",
      );
    }
    let channel = server.channelId
      ? await missingAsNull(() => guild.channels.fetch(server.channelId!))
      : null;
    const topic = `Pica server ${server.instanceId} · owner ${server.ownerId}`;
    if (!channel) {
      channel = (await guild.channels.fetch()).find((c) =>
        c?.type === ChannelType.GuildText && c.topic === topic
      ) ?? null;
    }
    if (channel && channel.type !== ChannelType.GuildText) {
      throw new InputError(
        "Your saved server channel is not a text channel. Contact an administrator.",
      );
    }
    const overwrites = privateOverwrites(
      guild.id,
      this.client.user!.id,
      server.ownerId,
    );
    if (!channel) {
      channel = await guild.channels.create({
        name: server.instanceId,
        topic,
        type: ChannelType.GuildText,
        parent: category.id,
        permissionOverwrites: overwrites,
      });
    } else {
      await channel.permissionOverwrites.set(overwrites);
    }
    if (server.channelId !== channel.id) {
      server.channelId = channel.id;
      server.consoleId = server.statusId = server.actionsId = null;
      this.store.save(server);
    }
  }

  private async channel(server: Server): Promise<TextChannel> {
    const guild = await this.client.guilds.fetch(server.guildId);
    const channel = server.channelId
      ? await missingAsNull(() => guild.channels.fetch(server.channelId!))
      : null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new InputError(
        "Your server channel expired. Click Open existing in #create-a-server to bring it back.",
      );
    }
    return channel;
  }

  /**
   * Console, status, and actions messages, in that order. A missing message is
   * resent; everything below it is resent too so the order never inverts.
   */
  async render(server: Server, view: ChannelView): Promise<void> {
    const channel = await this.channel(server);
    const parts = [
      { key: "consoleId" as const, tag: "console", payload: view.console },
      { key: "statusId" as const, tag: "status", payload: view.status },
      { key: "actionsId" as const, tag: "actions", payload: view.actions },
    ];
    let history: Collection<string, Message<true>> | undefined;
    let resend = false;
    for (const part of parts) {
      if (!part.payload) continue;
      let message = !resend && server[part.key]
        ? await missingAsNull(() => channel.messages.fetch(server[part.key]!))
        : null;
      if (!resend && !message) {
        history ??= await channel.messages.fetch({ limit: 100 });
        message = history.find((m) =>
          m.author.id === this.client.user!.id && m.embeds.some((e) =>
            e.footer?.text === `Pica · ${server.instanceId} · ${part.tag}`
          )
        ) ?? null;
      }
      if (message && !resend) {
        await message.edit(part.payload as never);
        server[part.key] = message.id;
      } else {
        // Delete the previous message (and any marker-found duplicate) so the
        // channel never accumulates orphaned panels with live buttons.
        const stale = message?.id ?? server[part.key];
        if (stale) {
          await missingAsNull(() => channel.messages.delete(stale));
        }
        message = await channel.send(part.payload as never);
        server[part.key] = message.id;
        resend = true;
      }
    }
    this.store.save(server);
  }

  async remove(server: Server): Promise<void> {
    if (!server.channelId) return;
    const guild = await this.client.guilds.fetch(server.guildId);
    const channel = await missingAsNull(() =>
      guild.channels.fetch(server.channelId!)
    );
    if (channel) {
      await channel.delete(
        "Pica server channel expired or was deleted by its owner",
      );
    }
  }
}
