import {
  AttachmentBuilder,
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
} from "discord.js";
import { Buffer } from "node:buffer";
import {
  InputError,
  type Instance,
  MAX_FILE_BYTES,
  PicaApi,
  PicaApiError,
  readBytes,
  validateId,
  validatePath,
} from "./api.ts";

export function authorized(
  guildId: string | null,
  administrator: boolean,
  guilds: ReadonlySet<string>,
): boolean {
  return guildId !== null && guilds.has(guildId) && administrator;
}
export class OperationLocks {
  private active = new Set<string>();
  async run<T>(id: string, operation: () => Promise<T>): Promise<T> {
    if (this.active.has(id)) {
      throw new InputError(
        "Another operation is in progress for this server. Wait for it to finish.",
      );
    }
    this.active.add(id);
    try {
      return await operation();
    } finally {
      this.active.delete(id);
    }
  }
}
export function bytes(value: number): string {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(2)} GiB`
    : `${(value / 1024 ** 2).toFixed(2)} MiB`;
}
function code(value: string): string {
  return `\`${value.replaceAll("`", "ˋ").replace(/[\r\n]/g, " ")}\``;
}
export function instanceDetails(instance: Instance): string {
  return [
    `**${instance.id}** — connect to ${code(instance.hostname)}`,
    `Connections: **${instance.connections}** (TCP sessions; may include users still signing in)`,
    `Storage: **${bytes(instance.usedBytes)} / ${
      bytes(instance.storageLimitBytes)
    }**`,
    `Resources: ${instance.memoryMiB} MiB RAM · ${instance.cpus} CPUs (fixed)`,
    instance.storageBlocked
      ? `⚠️ **Storage blocked.** Free space with ${
        code(`/pica files list id:${instance.id}`)
      }; file operations remain available.`
      : "",
    instance.restartRequired
      ? "⚠️ **Restart required** after a boot.jar change. Use /pica restart."
      : "",
  ].filter(Boolean).join("\n");
}
export function errorMessage(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof PicaApiError) {
    switch (error.status) {
      case 400:
        return `Check the supplied options: ${error.message}`;
      case 401:
        return "Pica authentication failed. Ask the bot operator to check its server configuration.";
      case 404:
        return "Server or file not found. Refresh with /pica list or /pica files list.";
      case 409:
        return `Pica could not complete this operation: ${error.message}`;
      case 413:
        return "This file exceeds Pica's 128 MiB upload limit.";
      case 502:
        return "Minecraft console is unavailable. Try again shortly.";
      case 503:
        return "All server slots are busy. Try again shortly.";
      default:
        return "Pica could not complete the request. Try again or contact the bot operator.";
    }
  }
  if (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return "The request timed out. It may still finish on Pica. Check status or files before retrying.";
  }
  return "The request could not be completed. Check Pica connectivity or contact the bot operator.";
}
export function confirmDelete(
  expected: string,
  confirmation: string | null,
): void {
  if (confirmation !== expected) {
    throw new InputError(
      "Confirmation did not match. Type the exact ID or path again to confirm permanent deletion.",
    );
  }
}
export async function downloadAttachment(
  url: string,
  declaredSize: number,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  if (declaredSize > MAX_FILE_BYTES) {
    throw new InputError("Uploads cannot exceed 128 MiB.");
  }
  const parsed = new URL(url);
  if (
    parsed.protocol !== "https:" ||
    !["cdn.discordapp.com", "media.discordapp.net"].includes(parsed.hostname) ||
    parsed.port || parsed.username || parsed.password ||
    !parsed.pathname.startsWith("/attachments/")
  ) {
    throw new InputError("Use a Discord file attachment for uploads.");
  }
  const response = await request(url, {
    signal: AbortSignal.timeout(180_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new InputError(
      "Could not download the Discord attachment. Attach it again and retry.",
    );
  }
  return readBytes(response, MAX_FILE_BYTES);
}
function paginate<T>(
  items: T[],
  page: number,
  size: number,
): { items: T[]; footer: string } {
  const pages = Math.max(1, Math.ceil(items.length / size));
  if (page > pages) throw new InputError(`Choose a page from 1 to ${pages}.`);
  return {
    items: items.slice((page - 1) * size, page * size),
    footer: `Page ${page}/${pages} · ${items.length} entries`,
  };
}

export function createHandler(api: PicaApi, guilds: ReadonlySet<string>) {
  const locks = new OperationLocks();
  return async (interaction: ChatInputCommandInteraction): Promise<void> => {
    if (interaction.commandName !== "pica") return;
    if (
      !authorized(
        interaction.guildId,
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ??
          false,
        guilds,
      )
    ) {
      await interaction.reply({
        content:
          "Pica is restricted to administrators in configured Discord servers.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const respond = async (text: string, file?: AttachmentBuilder) => {
      await interaction.editReply({
        content: api.redact(text).slice(0, 1950),
        allowedMentions: { parse: [] },
        files: file ? [file] : [],
      });
    };
    const output = (title: string, text: string) => {
      text = api.redact(text);
      if (text.length <= 1600) {
        return respond(
          `${title}\n\`\`\`text\n${text.replaceAll("```", "ˋˋˋ")}\n\`\`\``,
        );
      }
      const data = Buffer.from(text);
      if (data.length > interaction.attachmentSizeLimit) {
        return respond(
          `${title}\nOutput exceeds Discord's file limit; showing the end:\n\`\`\`text\n${
            text.slice(-1400).replaceAll("```", "ˋˋˋ")
          }\n\`\`\``,
        );
      }
      return respond(
        title,
        new AttachmentBuilder(data, { name: "pica-output.txt" }),
      );
    };
    const options = interaction.options;
    const subcommand = options.getSubcommand();
    const group = options.getSubcommandGroup();
    try {
      if (subcommand === "help") {
        await respond([
          "**Pica Minecraft hosting**",
          "`/pica list` · `/pica create` · `/pica status`",
          "Connect using the returned hostname; Minecraft preparation is automatic.",
          "`/pica prepare` explicitly prepares Minecraft. `/pica restart` applies JAR/config changes and disconnects players.",
          "`/pica tail` reads a console snapshot; `/pica run` executes an administrator command.",
          "`/pica files` lists, downloads, uploads, and manages files. Uploads replace the target. Some edits require a restart even without a restart warning.",
          "`/pica delete` permanently removes a server and all files; type the ID again to confirm. File deletion similarly requires the exact path.",
          "Create requires explicit acceptance of the Minecraft EULA: https://www.minecraft.net/eula",
          "All replies are private. Administrators in configured guilds share access to all Pica instances.",
        ].join("\n"));
        return;
      }
      if (!group && subcommand === "list") {
        const list = await api.list();
        const page = paginate(
          list.instances,
          options.getInteger("page") ?? 1,
          10,
        );
        await respond([
          `**Servers ${list.total}/${list.maxInstances}** · Occupied slots ${list.running}/${list.maxRunning}`,
          ...page.items.map((i) =>
            `${code(i.id)} → ${code(i.hostname)}${
              i.storageBlocked ? " ⚠️ storage blocked" : ""
            }${i.restartRequired ? " · restart required" : ""}`
          ),
          list.total ? page.footer : "No servers yet. Use /pica create.",
        ].join("\n"));
        return;
      }
      const id = validateId(options.getString("id", true));
      const execute = async () => {
        if (group === "files") {
          const path = validatePath(
            options.getString("path") ?? "",
            ["list", "stat"].includes(subcommand),
          );
          switch (subcommand) {
            case "list": {
              const result = await api.files(id, path);
              const page = paginate(
                result.entries,
                options.getInteger("page") ?? 1,
                10,
              );
              await output(
                `**${id}** · ${code(result.path)} · ${page.footer}`,
                page.items.map((f) =>
                  `${f.symlink ? "LINK" : f.directory ? "DIR " : "FILE"} ${
                    f.mode.toString(8).padStart(3, "0")
                  } ${bytes(f.size)} ${f.name}`
                ).join("\n") || "Empty directory.",
              );
              break;
            }
            case "stat": {
              const file = await api.stat(id, path);
              await output(
                `${id} · ${code(path || ".")}`,
                `${file.directory ? "Directory" : "File"}${
                  file.symlink ? " (symlink)" : ""
                }\nSize: ${bytes(file.size)}\nPermissions: ${
                  file.mode.toString(8).padStart(3, "0")
                }\nModified: ${file.modified}`,
              );
              break;
            }
            case "read": {
              const limit = Math.min(
                MAX_FILE_BYTES,
                interaction.attachmentSizeLimit,
              );
              const file = await api.stat(id, path);
              if (file.directory || file.symlink) {
                throw new InputError("Choose a regular file to download.");
              }
              if (file.size > limit) {
                throw new InputError(
                  `File exceeds the current transfer limit (${
                    bytes(limit)
                  }). Discord may allow less than Pica's 128 MiB.`,
                );
              }
              const data = await api.read(id, path, limit);
              await respond(
                `${id} · ${code(path)}`,
                new AttachmentBuilder(Buffer.from(data), {
                  name: path.split("/").at(-1)!,
                }),
              );
              break;
            }
            case "write": {
              if (options.getBoolean("confirm-replace") !== true) {
                throw new InputError(
                  "Set confirm-replace to true to acknowledge that the target file may be overwritten.",
                );
              }
              const attachment = options.getAttachment("file", true);
              const data = await downloadAttachment(
                attachment.url,
                attachment.size,
              );
              const result = await api.write(
                id,
                path,
                new Blob([new Uint8Array(data)]),
                attachment.name,
              );
              await respond(
                `Uploaded ${bytes(result.bytes)} to ${code(result.path)}.${
                  result.restartRequired
                    ? " **Restart required.** Use /pica restart."
                    : " Configuration changes may require /pica restart."
                }`,
              );
              break;
            }
            case "mkdir":
            case "rename":
            case "copy":
            case "delete":
            case "chmod": {
              if (subcommand === "delete") {
                confirmDelete(
                  options.getString("path", true),
                  options.getString("confirm-path"),
                );
              }
              const mode = options.getString("mode");
              if (subcommand === "chmod" && !/^[0-7]{3,4}$/.test(mode ?? "")) {
                throw new InputError(
                  "Use octal permissions such as 644, 0755, or 600.",
                );
              }
              const result = await api.mutate(id, subcommand, path, {
                destination: options.getString("destination") ?? undefined,
                recursive: options.getBoolean("recursive") ?? false,
                mode: mode === null ? undefined : Number.parseInt(mode, 8),
              });
              await respond(
                `${subcommand} completed: ${code(result.path)}.${
                  result.restartRequired
                    ? " **Restart required.**"
                    : " Configuration changes may require a restart."
                }`,
              );
              break;
            }
            default:
              throw new InputError("Unknown file command.");
          }
          return;
        }
        switch (subcommand) {
          case "create":
            await respond(
              instanceDetails(
                await api.create(id, options.getBoolean("accept-eula", true)),
              ),
            );
            break;
          case "status":
            await respond(instanceDetails(await api.instance(id, "status")));
            break;
          case "prepare":
            await respond(instanceDetails(await api.instance(id, "start")));
            break;
          case "restart": {
            const instance = await api.instance(id, "status");
            if (
              instance.connections > 0 &&
              options.getBoolean("confirm-disconnect") !== true
            ) {
              throw new InputError(
                `Restarting ${id} will disconnect connected players (${instance.connections} TCP sessions). Run /pica restart again with confirm-disconnect:true to confirm.`,
              );
            }
            await respond(instanceDetails(await api.instance(id, "restart")));
            break;
          }
          case "delete":
            confirmDelete(id, options.getString("confirm-id"));
            await api.instance(id, "delete");
            await respond(
              `Permanently deleted ${code(id)} and its server files.`,
            );
            break;
          case "tail": {
            const tail = await api.tail(id);
            await output(
              `**${id} console snapshot** · Run /pica tail to refresh.`,
              tail.lines.slice(-(options.getInteger("lines") ?? 20)).join(
                "\n",
              ) || "No console output yet.",
            );
            break;
          }
          case "run": {
            const result = await api.run(
              id,
              options.getString("command", true),
            );
            await output(
              `**${id} console**`,
              result.response || "Command completed with no output.",
            );
            break;
          }
          default:
            throw new InputError("Unknown Pica command.");
        }
      };
      const readOnly = group === "files"
        ? ["list", "stat", "read"].includes(subcommand)
        : ["status", "tail"].includes(subcommand);
      if (readOnly) await execute();
      else await locks.run(id, execute);
    } catch (error) {
      // Never log Discord request objects, interaction tokens, or raw fetch errors.
      if (error instanceof PicaApiError) {
        console.error(
          `Pica HTTP ${error.status}: ${api.redact(error.message)}`,
        );
      } else if (!(error instanceof InputError)) {
        console.error(
          "Pica operation failed:",
          error instanceof Error ? error.name : "Unknown error",
        );
      }
      await respond(errorMessage(error));
    }
  };
}
