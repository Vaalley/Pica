import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  MessageFlags,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from "discord.js";
import { Buffer } from "node:buffer";
import { type AddonResult, Catalogs, SOFTWARE } from "./catalogs.ts";
import { InputError, PicaApiError } from "./api.ts";
import { code, errorMessage } from "./common.ts";
import { Confirmations } from "./confirmations.ts";
import { FileManager } from "./filemanager.ts";
import { Servers } from "./service.ts";
import {
  addonSelect,
  confirmationButtons,
  consoleModal,
  inputModal,
  softwareSelect,
  versionSelect,
} from "./ui.ts";

export type PortalInteraction =
  | ButtonInteraction
  | ModalSubmitInteraction
  | StringSelectMenuInteraction;

export function createHandler(
  servers: Servers,
  guilds: ReadonlySet<string>,
  catalogs: Catalogs,
  files: FileManager,
) {
  const confirmations = new Confirmations();
  const searches = new Map<
    string,
    { ownerId: string; results: AddonResult[]; expires: number }
  >();
  const { api, store } = servers;
  return async (interaction: PortalInteraction): Promise<void> => {
    const customId = interaction.customId;
    if (!customId.startsWith("pica:")) return;
    const respond = async (
      content: string,
      components: ActionRowBuilder<ButtonBuilder>[] = [],
    ) => {
      const payload = {
        content: api.redact(content).slice(0, 1950),
        components,
        allowedMentions: { parse: [] as never[] },
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral });
      }
    };
    const output = async (title: string, text: string) => {
      text = api.redact(text);
      const budget = Math.max(100, 1850 - title.length);
      if (text.length <= budget) {
        await respond(
          `${title}\n\`\`\`text\n${text.replaceAll("```", "ˋˋˋ")}\n\`\`\``,
        );
      } else if (Buffer.byteLength(text) <= interaction.attachmentSizeLimit) {
        const payload = {
          content: title,
          components: [],
          files: [
            new AttachmentBuilder(Buffer.from(text), {
              name: "server-output.txt",
            }),
          ],
          allowedMentions: { parse: [] as never[] },
        };
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply(payload);
        } else {
          await interaction.reply({
            ...payload,
            flags: MessageFlags.Ephemeral,
          });
        }
      } else {
        await respond(
          `${title}\nOutput is too large; showing the end:\n\`\`\`text\n${
            text.slice(-Math.max(100, budget - 80)).replaceAll("```", "ˋˋˋ")
          }\n\`\`\``,
        );
      }
    };
    try {
      if (
        !interaction.guildId || !guilds.has(interaction.guildId) ||
        !interaction.channelId
      ) {
        throw new InputError(
          "Pica is only available in its configured Discord servers.",
        );
      }
      const guildId = interaction.guildId;
      const ownerId = interaction.user.id;
      const action = customId.split(":")[1];
      if (["create", "create-submit", "open"].includes(action)) {
        const setup = store.setup(guildId);
        if (
          setup?.lobbyId !== interaction.channelId ||
          (interaction.isButton() &&
            setup.messageId !== interaction.message?.id)
        ) {
          throw new InputError("Use the buttons in #create-a-server.");
        }
        if (action === "open") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const server = await servers.open(guildId, ownerId);
          await respond(
            `Your channel is back: <#${server.channelId}>. It expires one hour after you last use it.`,
          );
          return;
        }
        const existing = store.owner(ownerId);
        if (interaction.isButton() && !existing) {
          await interaction.showModal(
            inputModal(
              "pica:create-submit",
              "Create your Minecraft server",
              "confirmation",
              "Accept Minecraft EULA: type ACCEPT",
              "Read minecraft.net/eula, then type ACCEPT",
              "ACCEPT",
              20,
            ),
          );
          return;
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const eula = interaction.isModalSubmit()
          ? interaction.fields.getTextInputValue("confirmation")
          : "ACCEPT";
        const server = await servers.create(guildId, ownerId, eula);
        await respond(`Go to <#${server.channelId}> to manage your server.`);
        return;
      }
      const server = store.owned(guildId, ownerId, interaction.channelId);
      servers.touch(ownerId);
      if (interaction.isButton() && action === "command") {
        servers.ready(server);
        await interaction.showModal(consoleModal());
        return;
      }
      if (interaction.isButton() && action === "install") {
        servers.ready(server);
        await interaction.showModal(
          inputModal(
            "pica:install-submit",
            "Install a mod or plugin",
            "query",
            "Search",
            "Name or keywords. Sources match your server software.",
            "sodium, luckperms, worldedit…",
          ),
        );
        return;
      }
      if (interaction.isButton() && action === "ip") {
        servers.ready(server);
        await interaction.showModal(
          inputModal(
            "pica:ip-submit",
            "Change your join address",
            "subdomain",
            "Subdomain",
            "Lowercase letters, digits, hyphens.",
            "wild-willow",
            32,
          ),
        );
        return;
      }
      if (interaction.isButton() && action === "software") {
        servers.ready(server);
        await interaction.reply({
          ...softwareSelect(),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "delete") {
        if (!interaction.isButton()) {
          throw new InputError("Use the Delete server button.");
        }
        const token = confirmations.issue(server, "delete");
        await interaction.showModal(
          inputModal(
            `pica:delete-submit:${token}`,
            "Permanently delete your server?",
            "confirmation",
            "Delete all files and channel: type DELETE",
            "Players disconnect. This cannot be undone.",
            "DELETE",
            20,
          ),
        );
        return;
      }
      if (action === "restart" || action === "stop") {
        servers.ready(server);
        const token = confirmations.issue(server, action);
        await interaction.reply({
          content: action === "restart"
            ? "Restart your server now? Connected players will be disconnected."
            : "Stop your server now? Connected players will be disconnected.",
          components: confirmationButtons(token),
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      if (action === "confirm" || action === "cancel") {
        const confirmed = confirmations.consume(customId.split(":")[2], server);
        if (!interaction.isButton()) {
          throw new InputError("Use the confirmation buttons.");
        }
        await interaction.update({
          content: action === "cancel"
            ? "Canceled."
            : "Working on your server…",
          components: [],
        });
        if (action === "cancel") return;
        if (confirmed === "delete") {
          throw new InputError("Use the delete confirmation form.");
        }
        await servers.action(server, confirmed);
        await respond(
          confirmed === "stop"
            ? "Minecraft stopped. Click Start when you're ready to play again."
            : "Your server has restarted. You can rejoin now.",
        );
        return;
      }
      if (
        (interaction.isButton() || interaction.isStringSelectMenu()) &&
        interaction.message.flags?.has(MessageFlags.Ephemeral)
      ) {
        await interaction.deferUpdate();
      } else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      }
      if (action === "delete-submit" && interaction.isModalSubmit()) {
        if (
          confirmations.consume(customId.split(":")[2], server) !== "delete"
        ) throw new InputError("Choose Delete server again.");
        await respond(
          "Deleting your server and all its files. This channel will disappear when deletion is complete.",
        );
        await servers.delete(
          server,
          interaction.fields.getTextInputValue("confirmation"),
        );
        return;
      }
      if (action === "retry") {
        await servers.create(guildId, ownerId, "ACCEPT");
        await respond("Your server channel is ready. Use the controls above.");
        return;
      }
      if (action === "start") {
        const instance = await servers.action(server, "start");
        await respond(
          `Your server is ready! Join ${
            code(server.hostname ?? instance.hostname)
          }.`,
        );
        return;
      }
      if (action === "files") {
        servers.ready(server);
        const url = files.issue(ownerId, server.instanceId);
        const link = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(url)
            .setLabel("Open File Manager"),
        );
        await respond(
          "Your file manager is ready. The link works until this channel expires.",
          [link],
        );
        return;
      }
      if (action === "ip-submit" && interaction.isModalSubmit()) {
        const subdomain = interaction.fields.getTextInputValue("subdomain")
          .trim().toLowerCase();
        await servers.setHostname(server, subdomain);
        await respond(`Your join address is now ${code(server.hostname!)}.`);
        return;
      }
      if (action === "command-submit" && interaction.isModalSubmit()) {
        servers.ready(server);
        const command = interaction.fields.getTextInputValue("command");
        const response = await servers.command(server, command);
        await output("Console response", response);
        return;
      }
      if (action === "install-submit" && interaction.isModalSubmit()) {
        servers.ready(server);
        const query = interaction.fields.getTextInputValue("query").trim();
        if (server.software === "vanilla") {
          throw new InputError(
            "Vanilla can't load mods or plugins. Use Change software first.",
          );
        }
        const modded = server.software === "fabric";
        const results = server.software
          ? await catalogs.searchAddons(modded ? "mod" : "plugin", query)
          : [
            ...(await catalogs.searchAddons("mod", query)),
            ...(await catalogs.searchAddons("plugin", query)),
          ].slice(0, 10);
        if (!results.length) {
          throw new InputError(
            `Nothing found for "${query}". Try fewer words.`,
          );
        }
        for (const [token, pending] of searches) {
          if (pending.expires < Date.now() || searches.size > 50) {
            searches.delete(token);
          }
        }
        const token = crypto.randomUUID();
        searches.set(token, {
          ownerId,
          results,
          expires: Date.now() + 300_000,
        });
        const menu = addonSelect(token, results);
        await interaction.editReply({
          content: api.redact(menu.content),
          components: menu.components,
          allowedMentions: { parse: [] as never[] },
        });
        return;
      }
      if (action === "addon-pick" && interaction.isStringSelectMenu()) {
        servers.ready(server);
        const pending = searches.get(customId.split(":")[2]);
        if (!pending || pending.ownerId !== ownerId) {
          throw new InputError("This search expired. Search again.");
        }
        const result = pending.results[Number(interaction.values[0])];
        if (!result) throw new InputError("Choose a result from the list.");
        searches.delete(customId.split(":")[2]);
        const loader = server.software === "fabric" ? "fabric" : undefined;
        const file = await catalogs.addonFile(result, undefined, loader);
        const data = await catalogs.download(file);
        const dir = result.source === "modrinth" ? "mods" : "plugins";
        await servers.installFile(
          server,
          `${dir}/${file.filename}`,
          data,
          file.filename,
          `Installed ${result.name}.`,
        );
        await respond(`Installed ${result.name} to ${code(dir + "/")}.`);
        return;
      }
      if (action === "software-pick" && interaction.isStringSelectMenu()) {
        servers.ready(server);
        const software = interaction.values[0] as keyof typeof SOFTWARE;
        if (!(software in SOFTWARE)) {
          throw new InputError("Choose a software from the list.");
        }
        const versions = await catalogs.softwareVersions(software);
        const menu = versionSelect(software, SOFTWARE[software], versions);
        await interaction.editReply({
          content: api.redact(menu.content),
          components: menu.components,
          allowedMentions: { parse: [] as never[] },
        });
        return;
      }
      if (action === "version-pick" && interaction.isStringSelectMenu()) {
        servers.ready(server);
        const software = customId.split(":")[2] as keyof typeof SOFTWARE;
        if (!(software in SOFTWARE)) {
          throw new InputError("Choose a software from the list.");
        }
        const version = interaction.values[0];
        const file = await catalogs.softwareJar(software, version);
        const data = await catalogs.download(file);
        await servers.installFile(
          server,
          "boot.jar",
          data,
          file.filename,
          `Installed ${SOFTWARE[software]} ${version}.`,
          software,
        );
        await respond(
          `Installed ${SOFTWARE[software]} ${version}. Restart to apply it.`,
        );
        return;
      }
      throw new InputError("Use the controls in your server channel.");
    } catch (error) {
      if (error instanceof PicaApiError) {
        console.error(
          `Pica HTTP ${error.status}: ${api.redact(error.message)}`,
        );
      } else if (!(error instanceof InputError)) {
        console.error(
          "Pica interaction failed:",
          error instanceof Error ? error.name : "Unknown error",
        );
      }
      const own = store.owner(interaction.user.id);
      const recovery = own?.guildId === interaction.guildId && own?.channelId &&
          own.phase === "provisioning"
        ? `\nYour private channel is <#${own.channelId}>. Use Finish setup there to retry.`
        : "";
      await respond(errorMessage(error) + recovery);
    }
  };
}
