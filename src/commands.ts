import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from "discord.js";

const command = (name: string, description: string) =>
  new SlashCommandBuilder().setName(name).setDescription(description)
    .setDMPermission(false);
const path = (c: SlashCommandSubcommandBuilder, required = true) =>
  c.addStringOption((o) =>
    o.setName("path").setDescription("Path inside your Minecraft server")
      .setRequired(required).setMaxLength(512)
  );
const upload = (name: string, description: string) =>
  command(name, description)
    .addAttachmentOption((o) =>
      o.setName("file").setDescription("File to upload").setRequired(true)
    )
    .addBooleanOption((o) =>
      o.setName("confirm-replace").setDescription(
        "I agree to replace the existing file at this location",
      ).setRequired(true)
    );

export const commands = [
  command("setup", "Set up the Create server lobby and private server category")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  command("start", "Start your Minecraft server"),
  command("stop", "Stop your Minecraft server"),
  command("restart", "Restart your Minecraft server"),
  command("status", "Refresh your server details and join address"),
  command("panel", "Restore the controls in your private server channel"),
  command(
    "delete-server",
    "Permanently delete your Minecraft server and private channel",
  ),
  command("console", "Read your Minecraft console or run a command")
    .addStringOption((o) =>
      o.setName("command").setDescription(
        "One Minecraft command, without a leading /",
      ).setMaxLength(4096)
    )
    .addIntegerOption((o) =>
      o.setName("lines").setDescription("Recent lines to show (default 20)")
        .setMinValue(1).setMaxValue(1000)
    ),
  upload("upload", "Upload a file to your Minecraft server")
    .addStringOption((o) =>
      o.setName("path").setDescription("Destination, e.g. plugins/Example.jar")
        .setRequired(true).setMaxLength(512)
    ),
  upload(
    "server-software",
    "Install your server JAR as boot.jar; restart afterward",
  ),
  command("files", "Manage the files inside your Minecraft server")
    .addSubcommand((c) =>
      path(c.setName("list").setDescription("Browse your files"), false)
        .addIntegerOption((o) =>
          o.setName("page").setDescription("Page number").setMinValue(1)
        )
    )
    .addSubcommand((c) =>
      path(c.setName("download").setDescription("Download a file"))
    )
    .addSubcommand((c) =>
      path(c.setName("mkdir").setDescription("Create a folder"))
    )
    .addSubcommand((c) =>
      path(
        c.setName("rename").setDescription("Move or rename a file or folder"),
      )
        .addStringOption((o) =>
          o.setName("destination").setDescription("New path").setRequired(true)
        )
    )
    .addSubcommand((c) =>
      path(c.setName("copy").setDescription("Copy a file or folder"))
        .addStringOption((o) =>
          o.setName("destination").setDescription("New path").setRequired(true)
        )
        .addBooleanOption((o) =>
          o.setName("recursive").setDescription(
            "Include everything inside the folder",
          )
        )
    )
    .addSubcommand((c) =>
      path(
        c.setName("delete").setDescription(
          "Permanently delete a file or folder",
        ),
      )
        .addStringOption((o) =>
          o.setName("confirm-path").setDescription(
            "Repeat the exact path to confirm permanent deletion",
          ).setRequired(true)
        )
        .addBooleanOption((o) =>
          o.setName("recursive").setDescription(
            "Delete everything inside the folder",
          )
        )
    )
    .addSubcommand((c) =>
      path(c.setName("chmod").setDescription("Change file permissions"))
        .addStringOption((o) =>
          o.setName("mode").setDescription("Octal permissions, e.g. 644 or 755")
            .setRequired(true)
        )
    ),
];
export const commandNames = new Set(commands.map((c) => c.name));
