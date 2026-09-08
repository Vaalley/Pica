import {
  PermissionFlagsBits,
  SlashCommandBuilder,
  SlashCommandSubcommandBuilder,
} from "discord.js";

function id(command: SlashCommandSubcommandBuilder) {
  return command.addStringOption((o) =>
    o.setName("id").setDescription("Minecraft server ID").setRequired(true)
      .setMaxLength(32)
  );
}
function path(command: SlashCommandSubcommandBuilder, required = true) {
  return command.addStringOption((o) =>
    o.setName("path").setDescription("Relative path using / separators")
      .setRequired(required).setMaxLength(512)
  );
}
function page(command: SlashCommandSubcommandBuilder) {
  return command.addIntegerOption((o) =>
    o.setName("page").setDescription("Page number").setMinValue(1)
  );
}

export const picaCommand = new SlashCommandBuilder()
  .setName("pica")
  .setDescription("Manage Pica Minecraft servers")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .setDMPermission(false)
  .addSubcommand((c) => c.setName("help").setDescription("How to use Pica"))
  .addSubcommand((c) =>
    page(
      c.setName("list").setDescription("List Minecraft servers and capacity"),
    )
  )
  .addSubcommand((c) =>
    id(c.setName("create").setDescription("Create a Minecraft server"))
      .addBooleanOption((o) =>
        o.setName("accept-eula").setDescription(
          "I accept https://www.minecraft.net/eula",
        ).setRequired(true)
      )
  )
  .addSubcommand((c) =>
    id(
      c.setName("status").setDescription(
        "Show hostname, connections, and storage",
      ),
    )
  )
  .addSubcommand((c) =>
    id(
      c.setName("prepare").setDescription(
        "Ensure Minecraft is ready; connections normally handle this automatically",
      ),
    )
  )
  .addSubcommand((c) =>
    id(
      c.setName("restart").setDescription(
        "Restart Minecraft to apply changes; disconnects connected players",
      ),
    )
      .addBooleanOption((o) =>
        o.setName("confirm-disconnect").setDescription(
          "I confirm connected players will be disconnected",
        )
      )
  )
  .addSubcommand((c) =>
    id(
      c.setName("delete").setDescription(
        "PERMANENTLY delete a server and all its files",
      ),
    )
      .addStringOption((o) =>
        o.setName("confirm-id").setDescription(
          "Type the server ID again to confirm permanent deletion",
        ).setRequired(true)
      )
  )
  .addSubcommand((c) =>
    id(
      c.setName("tail").setDescription(
        "Read a snapshot of recent Minecraft console output",
      ),
    )
      .addIntegerOption((o) =>
        o.setName("lines").setDescription("Latest lines to show (default 20)")
          .setMinValue(1).setMaxValue(1000)
      )
  )
  .addSubcommand((c) =>
    id(
      c.setName("run").setDescription(
        "Run an administrator Minecraft console command",
      ),
    )
      .addStringOption((o) =>
        o.setName("command").setDescription(
          "One console command, without a leading /",
        ).setRequired(true).setMaxLength(4096)
      )
  )
  .addSubcommandGroup((g) =>
    g.setName("files").setDescription("Manage Minecraft server files")
      .addSubcommand((c) =>
        page(
          path(id(c.setName("list").setDescription("List a directory")), false),
        )
      )
      .addSubcommand((c) =>
        path(
          id(
            c.setName("stat").setDescription("Show file or directory metadata"),
          ),
        )
      )
      .addSubcommand((c) =>
        path(id(c.setName("read").setDescription("Download a file privately")))
      )
      .addSubcommand((c) =>
        path(id(c.setName("write").setDescription("Upload or replace a file")))
          .addAttachmentOption((o) =>
            o.setName("file").setDescription(
              "File to upload (maximum 128 MiB; Discord limits also apply)",
            ).setRequired(true)
          )
          .addBooleanOption((o) =>
            o.setName("confirm-replace").setDescription(
              "I confirm the target file may be overwritten",
            ).setRequired(true)
          )
      )
      .addSubcommand((c) =>
        path(
          id(
            c.setName("mkdir").setDescription(
              "Create a directory and missing parents",
            ),
          ),
        )
      )
      .addSubcommand((c) =>
        path(
          id(
            c.setName("rename").setDescription(
              "Move or rename a file or directory",
            ),
          ),
        )
          .addStringOption((o) =>
            o.setName("destination").setDescription(
              "New relative path (must not exist)",
            ).setRequired(true)
          )
      )
      .addSubcommand((c) =>
        path(
          id(c.setName("copy").setDescription("Copy up to 128 MiB of files")),
        )
          .addStringOption((o) =>
            o.setName("destination").setDescription(
              "New relative path (must not exist)",
            ).setRequired(true)
          )
          .addBooleanOption((o) =>
            o.setName("recursive").setDescription("Include directory contents")
          )
      )
      .addSubcommand((c) =>
        path(
          id(
            c.setName("delete").setDescription(
              "PERMANENTLY delete a file or directory",
            ),
          ),
        )
          .addStringOption((o) =>
            o.setName("confirm-path").setDescription(
              "Type the path again to confirm permanent deletion",
            ).setRequired(true)
          )
          .addBooleanOption((o) =>
            o.setName("recursive").setDescription(
              "Delete all directory contents too",
            )
          )
      )
      .addSubcommand((c) =>
        path(id(c.setName("chmod").setDescription("Change file permissions")))
          .addStringOption((o) =>
            o.setName("mode").setDescription(
              "Octal rwx permissions, e.g. 644 or 755",
            ).setRequired(true)
          )
      )
  );
