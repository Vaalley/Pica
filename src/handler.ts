import {
  type ActionRowBuilder,
  AttachmentBuilder,
  type ButtonBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  MessageFlags,
  type ModalSubmitInteraction,
  PermissionFlagsBits,
} from "discord.js";
import { Buffer } from "node:buffer";
import {
  InputError,
  MAX_FILE_BYTES,
  PicaApiError,
  validatePath,
} from "./api.ts";
import { commandNames } from "./commands.ts";
import { bytes, code, downloadAttachment, errorMessage } from "./common.ts";
import { Confirmations } from "./confirmations.ts";
import { type DiscordRooms } from "./discord.ts";
import { Servers } from "./service.ts";
import {
  confirmationButtons,
  consoleButtons,
  consoleModal,
  restartButton,
  textModal,
  uploadModal,
} from "./ui.ts";

export type PortalInteraction =
  | ButtonInteraction
  | ChatInputCommandInteraction
  | ModalSubmitInteraction;
export function createHandler(
  servers: Servers,
  rooms: Pick<DiscordRooms, "setup">,
  guilds: ReadonlySet<string>,
  download = downloadAttachment,
) {
  const confirmations = new Confirmations();
  const { api, store } = servers;
  return async (interaction: PortalInteraction): Promise<void> => {
    const slash = interaction.isChatInputCommand() ? interaction : null;
    const customId = !interaction.isChatInputCommand()
      ? interaction.customId
      : "";
    if (
      slash
        ? !commandNames.has(slash.commandName)
        : !customId.startsWith("pica:")
    ) return;
    const respond = async (
      content: string,
      file?: AttachmentBuilder,
      components: ActionRowBuilder<ButtonBuilder>[] = [],
    ) => {
      const payload = {
        content: api.redact(content).slice(0, 1950),
        components,
        allowedMentions: { parse: [] as never[] },
        files: file ? [file] : [],
      };
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
      } else {await interaction.reply({
          ...payload,
          flags: MessageFlags.Ephemeral,
        });}
    };
    const output = async (
      title: string,
      text: string,
      components: ActionRowBuilder<ButtonBuilder>[] = [],
    ) => {
      text = api.redact(text);
      const budget = Math.max(100, 1850 - title.length);
      if (text.length <= budget) {
        await respond(
          `${title}\n\`\`\`text\n${text.replaceAll("```", "ˋˋˋ")}\n\`\`\``,
          undefined,
          components,
        );
      } else if (Buffer.byteLength(text) <= interaction.attachmentSizeLimit) {
        await respond(
          title,
          new AttachmentBuilder(Buffer.from(text), {
            name: "server-output.txt",
          }),
          components,
        );
      } else {await respond(
          `${title}\nOutput is too large; showing the end:\n\`\`\`text\n${
            text.slice(-Math.max(100, budget - 80)).replaceAll("```", "ˋˋˋ")
          }\n\`\`\``,
          undefined,
          components,
        );}
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
      if (slash?.commandName === "setup") {
        if (
          !interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
        ) {
          throw new InputError(
            "Only a Discord server administrator can run /setup.",
          );
        }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const guild = await interaction.client.guilds.fetch(guildId);
        const channelId = await rooms.setup(guild);
        await respond(
          `Ready! Members can create their Minecraft server in <#${channelId}>.`,
        );
        return;
      }
      if (customId === "pica:create" || customId === "pica:create-submit") {
        const setup = store.setup(guildId);
        if (
          setup?.lobbyId !== interaction.channelId ||
          (interaction.isButton() && setup.messageId !== interaction.message.id)
        ) {
          throw new InputError(
            "Use the Create server button in #create-a-server.",
          );
        }
        const existing = store.owner(ownerId);
        if (interaction.isButton() && !existing) {
          await interaction.showModal(
            textModal(
              "pica:create-submit",
              "Create your Minecraft server",
              "Accept Minecraft EULA: type ACCEPT",
              "Read minecraft.net/eula, then type ACCEPT",
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
      const action = slash?.commandName ?? customId.split(":")[1];
      if (
        interaction.isButton() &&
        ["upload", "software", "command"].includes(action)
      ) {
        servers.ready(server);
        await interaction.showModal(
          action === "command"
            ? consoleModal()
            : uploadModal(action === "software"),
        );
        return;
      }
      if (action === "delete-server" || action === "delete") {
        if (!interaction.isButton() && !interaction.isChatInputCommand()) {
          throw new InputError("Use the Delete server button.");
        }
        const token = confirmations.issue(server, "delete");
        await interaction.showModal(
          textModal(
            `pica:delete-submit:${token}`,
            "Permanently delete your server?",
            "Delete all files and channel: type DELETE",
            "Players disconnect. This cannot be undone.",
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
            ? "Minecraft stopped. Click Start when you’re ready to play again."
            : "Your server has restarted. You can rejoin now.",
        );
        return;
      }
      if (
        interaction.isButton() &&
        interaction.message.flags?.has(MessageFlags.Ephemeral)
      ) await interaction.deferUpdate();
      else await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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
      if (action === "panel") {
        await servers.locks.run(
          ownerId,
          () =>
            server.phase === "ready"
              ? servers.refreshPanel(server)
              : servers.paint(server),
        );
        await respond("Your server controls are ready above.");
        return;
      }
      if (action === "start" || action === "status") {
        const instance = await servers.action(server, action);
        await respond(
          `${
            action === "start"
              ? "Your server is ready!"
              : "Server details refreshed."
          } Join ${code(instance.hostname)}.`,
        );
        return;
      }
      servers.ready(server);
      await servers.locks.run(ownerId, async () => {
        servers.ready(server);
        if (action === "console" || action === "command-submit") {
          const command = interaction.isModalSubmit()
            ? interaction.fields.getTextInputValue("command")
            : slash?.options.getString("command");
          if (command) {
            const result = await api.run(server.instanceId, command);
            await output(
              "Console response",
              result.response || "Command completed with no output.",
              consoleButtons(),
            );
          } else {
            const result = await api.tail(server.instanceId);
            await output(
              "Recent console output",
              result.lines.slice(-(slash?.options.getInteger("lines") ?? 20))
                .join("\n") || "No console output yet.",
              consoleButtons(),
            );
          }
          return;
        }
        if (
          ["upload", "server-software", "upload-submit", "software-submit"]
            .includes(action)
        ) {
          const modal = interaction.isModalSubmit() ? interaction : null;
          const software = action === "server-software" ||
            action === "software-submit";
          if (
            modal
              ? modal.fields.getTextInputValue("confirmation").trim() !==
                "REPLACE"
              : slash?.options.getBoolean("confirm-replace") !== true
          ) {
            throw new InputError("Confirm replacement to upload this file.");
          }
          const attachment = modal
            ? modal.fields.getUploadedFiles("file", true).first()
            : slash!.options.getAttachment("file", true);
          if (!attachment) throw new InputError("Choose one file to upload.");
          const path = software ? "boot.jar" : validatePath(
            modal
              ? modal.fields.getTextInputValue("path")
              : slash!.options.getString("path", true),
          );
          if (
            software &&
            !attachment.name.toLowerCase().endsWith(".jar")
          ) throw new InputError("Attach a Minecraft server .jar file.");
          if (attachment.size > MAX_FILE_BYTES) {
            throw new InputError("Uploads cannot exceed 128 MiB.");
          }
          await servers.paint(
            server,
            `Uploading ${code(attachment.name)}…`,
            true,
          );
          try {
            const data = await download(
              attachment.url,
              attachment.size,
            );
            const result = await api.write(
              server.instanceId,
              path,
              new Blob([new Uint8Array(data)]),
              attachment.name,
            );
            await servers.refreshPanel(
              server,
              `Uploaded ${code(result.path)}.${
                result.restartRequired || path === "boot.jar"
                  ? " Restart to apply your server software."
                  : " Some configuration changes require a restart."
              }`,
            );
            await respond(
              `Uploaded ${bytes(result.bytes)} to ${code(result.path)}. ${
                result.restartRequired || path === "boot.jar"
                  ? "Click Restart to apply your server software."
                  : "Some configuration changes require a restart."
              }`,
              undefined,
              result.restartRequired || path === "boot.jar"
                ? restartButton()
                : [],
            );
          } catch (error) {
            await servers.paint(server, errorMessage(error));
            throw error;
          }
          return;
        }
        if (action === "files") {
          const subcommand = slash?.options.getSubcommand() ?? "list";
          const path = validatePath(
            slash?.options.getString("path") ?? "",
            subcommand === "list",
          );
          if (subcommand === "list") {
            const result = await api.files(server.instanceId, path);
            const page = slash?.options.getInteger("page") ?? 1;
            const pages = Math.max(1, Math.ceil(result.entries.length / 15));
            if (page > pages) {
              throw new InputError(`Choose a page from 1 to ${pages}.`);
            }
            await output(
              `${
                code(result.path)
              } · Page ${page}/${pages} · Use /files to browse or manage files.`,
              result.entries.slice((page - 1) * 15, page * 15).map((f) =>
                `${f.symlink ? "LINK" : f.directory ? "DIR " : "FILE"} ${
                  bytes(f.size)
                } ${f.name}`
              ).join("\n") || "This folder is empty.",
            );
          } else if (subcommand === "download") {
            const limit = Math.min(
              MAX_FILE_BYTES,
              interaction.attachmentSizeLimit,
            );
            const file = await api.stat(server.instanceId, path);
            if (file.directory || file.symlink) {
              throw new InputError("Choose a regular file to download.");
            }
            if (file.size > limit) {
              throw new InputError(
                `File exceeds the current download limit (${bytes(limit)}).`,
              );
            }
            const data = await api.read(server.instanceId, path, limit);
            await respond(
              code(path),
              new AttachmentBuilder(Buffer.from(data), {
                name: path.split("/").at(-1)!,
              }),
            );
          } else if (
            slash &&
            ["mkdir", "rename", "copy", "delete", "chmod"].includes(subcommand)
          ) {
            if (
              subcommand === "delete" &&
              slash.options.getString("confirm-path") !==
                slash.options.getString("path")
            ) {
              throw new InputError(
                "Repeat the exact path in confirm-path to permanently delete it.",
              );
            }
            const mode = slash.options.getString("mode");
            if (subcommand === "chmod" && !/^[0-7]{3,4}$/.test(mode ?? "")) {
              throw new InputError(
                "Use octal permissions such as 644 or 0755.",
              );
            }
            const result = await api.mutate(
              server.instanceId,
              subcommand as "mkdir" | "rename" | "copy" | "delete" | "chmod",
              path,
              {
                destination: slash.options.getString("destination") ??
                  undefined,
                recursive: slash.options.getBoolean("recursive") ?? false,
                mode: mode ? Number.parseInt(mode, 8) : undefined,
              },
            );
            await servers.refreshPanel(
              server,
              "Files updated. Configuration changes may need a restart.",
            );
            await respond(
              `${subcommand} completed: ${code(result.path)}.${
                result.restartRequired
                  ? " Click Restart to apply the change."
                  : ""
              }`,
            );
          }
          return;
        }
        throw new InputError("Use the controls in your server channel.");
      });
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
