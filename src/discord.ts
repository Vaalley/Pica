import {
  ChannelType,
  type Client,
  type Guild,
  OverwriteType,
  PermissionFlagsBits as P,
  type TextChannel,
} from "discord.js";
import { InputError, type Instance } from "./api.ts";
import { OperationLocks } from "./common.ts";
import { type Rooms } from "./service.ts";
import { type Server, Store } from "./store.ts";
import { lobbyPanel, serverPanel } from "./ui.ts";

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
        P.UseApplicationCommands,
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
      throw new InputError("Ask an administrator to run /setup first.");
    }
    const category = await missingAsNull(() =>
      guild.channels.fetch(setup.categoryId!)
    );
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new InputError(
        "The server category was removed. Ask an administrator to run /setup again.",
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
        name: `server-${server.instanceId.slice(2)}`,
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
      server.panelId = null;
      this.store.save(server);
    }
  }

  private async channel(server: Server): Promise<TextChannel> {
    const guild = await this.client.guilds.fetch(server.guildId);
    const channel = server.channelId
      ? await guild.channels.fetch(server.channelId)
      : null;
    if (!channel || channel.type !== ChannelType.GuildText) {
      throw new InputError(
        "Your server channel is missing. Click Create server in the lobby to restore it.",
      );
    }
    return channel;
  }
  async panel(
    server: Server,
    instance?: Instance,
    notice?: string,
  ): Promise<void> {
    const channel = await this.channel(server);
    let message = server.panelId
      ? await missingAsNull(() => channel.messages.fetch(server.panelId!))
      : null;
    if (!message) {
      message = (await channel.messages.fetch({ limit: 100 })).find((m) =>
        m.author.id === this.client.user!.id && m.embeds.some((e) =>
          e.footer?.text === `Pica · ${server.instanceId}`
        )
      ) ?? null;
    }
    if (message) await message.edit(serverPanel(server, instance, notice));
    else message = await channel.send(serverPanel(server, instance, notice));
    server.panelId = message.id;
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
        "Owner confirmed permanent deletion of their Pica server",
      );
    }
  }
}
