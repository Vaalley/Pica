import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  FileUploadBuilder,
  LabelBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { type Instance } from "./api.ts";
import { bytes, code } from "./common.ts";
import { type Server } from "./store.ts";

function button(action: string, label: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(`pica:${action}`).setLabel(label)
    .setStyle(style);
}
export function lobbyPanel() {
  return {
    embeds: [
      new EmbedBuilder().setColor(0x65c9a5).setTitle(
        "Your own Minecraft server",
      )
        .setDescription(
          "Create your server and get a private channel to manage it.\n\nOne server per person. Start, stop, restart, and upload files from your channel.",
        )
        .addFields({
          name: "Before you create",
          value:
            "You’ll be asked to accept the [Minecraft EULA](https://www.minecraft.net/eula).",
        })
        .setFooter({ text: "Pica · Personal Minecraft hosting" }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("create", "Create server", ButtonStyle.Success),
      ),
    ],
    allowedMentions: { parse: [] as never[] },
  };
}
export function serverPanel(
  server: Server,
  instance?: Instance,
  notice?: string,
  busy = false,
) {
  const embed = new EmbedBuilder().setColor(0x65c9a5).setTitle(
    "Your Minecraft server",
  )
    .setFooter({ text: `Pica · ${server.instanceId}` }).setTimestamp();
  if (server.phase === "provisioning") {
    embed.setDescription(
      notice ??
        "This is your private server channel. Use **Finish setup** to continue creating your Minecraft server.",
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(
            "retry",
            busy ? "Creating server…" : "Finish setup",
            ButtonStyle.Primary,
          ).setDisabled(busy),
        ),
      ],
      allowedMentions: { parse: [] as never[] },
    };
  }
  if (server.phase === "deleting" || server.phase === "deleted") {
    embed.setDescription(
      notice ??
        "Server deletion needs to finish. Use **Finish deletion** to resume. This permanently removes the server files and this channel.",
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button(
            "delete",
            busy ? "Deleting…" : "Finish deletion",
            ButtonStyle.Danger,
          ).setDisabled(busy),
        ),
      ],
      allowedMentions: { parse: [] as never[] },
    };
  }
  embed.setDescription(
    [
      notice,
      busy
        ? "Please wait. This can take up to three minutes."
        : "Manage your server below. Upload files, change server software, or open the console without leaving Discord.",
    ].filter(Boolean).join("\n\n"),
  );
  if (instance?.hostname || server.hostname) {
    embed.addFields({
      name: "Join address",
      value: code(instance?.hostname ?? server.hostname!),
    });
  }
  if (instance) {
    embed.addFields(
      {
        name: "Connections",
        value: `${instance.connections} TCP sessions`,
        inline: true,
      },
      {
        name: "Storage",
        value: `${bytes(instance.usedBytes)} / ${
          bytes(instance.storageLimitBytes)
        }`,
        inline: true,
      },
    );
    if (instance.storageBlocked) {
      embed.addFields({
        name: "⚠️ Storage is full",
        value:
          "Open **Files** to find unneeded files, then use `/files delete` to free space. File management remains available.",
      });
    }
    if (instance.restartRequired) {
      embed.addFields({
        name: "Restart needed",
        value: "Your server software changed. Click Restart to apply it.",
      });
    }
  }
  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("start", "Start", ButtonStyle.Success),
        button("stop", "Stop"),
        button("restart", "Restart", ButtonStyle.Primary),
        button("status", "Refresh"),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("console", "Console"),
        button("files", "Files"),
        button("upload", "Upload"),
        button("software", "Server software"),
      ),
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("delete", "Delete server", ButtonStyle.Danger),
      ),
    ].map((row) => {
      for (const component of row.components) component.setDisabled(busy);
      return row;
    }),
    allowedMentions: { parse: [] as never[] },
  };
}
export function textModal(
  customId: string,
  title: string,
  label: string,
  placeholder: string,
) {
  return new ModalBuilder().setCustomId(customId).setTitle(title).addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder().setCustomId("confirmation").setLabel(label)
        .setPlaceholder(placeholder)
        .setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(20),
    ),
  );
}
export function confirmationButtons(token: string) {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    button(`confirm:${token}`, "Confirm", ButtonStyle.Danger),
    button(`cancel:${token}`, "Cancel"),
  )];
}

export function uploadModal(software: boolean) {
  const modal = new ModalBuilder().setCustomId(
    software ? "pica:software-submit" : "pica:upload-submit",
  )
    .setTitle(software ? "Install server software" : "Upload a file");
  if (!software) {
    modal.addLabelComponents(
      new LabelBuilder().setLabel("Destination path")
        .setDescription(
          "Relative to your Minecraft server, using / between folders.",
        )
        .setTextInputComponent(
          new TextInputBuilder().setCustomId("path").setStyle(
            TextInputStyle.Short,
          ).setPlaceholder("plugins/MyPlugin.jar").setRequired(true)
            .setMaxLength(512),
        ),
    );
  }
  modal.addLabelComponents(
    new LabelBuilder().setLabel(software ? "Minecraft server JAR" : "File")
      .setDescription(
        software
          ? "Installed as boot.jar. Must support Java 25 and port 25565."
          : "Up to 128 MiB. Discord's upload limit also applies.",
      )
      .setFileUploadComponent(
        new FileUploadBuilder().setCustomId("file").setMinValues(1)
          .setMaxValues(1).setRequired(true),
      ),
    new LabelBuilder().setLabel("Confirm replacement")
      .setDescription("Type REPLACE to allow overwriting the destination file.")
      .setTextInputComponent(
        new TextInputBuilder().setCustomId("confirmation").setStyle(
          TextInputStyle.Short,
        ).setPlaceholder("REPLACE").setRequired(true).setMaxLength(20),
      ),
  );
  return modal;
}

export function consoleModal() {
  return new ModalBuilder().setCustomId("pica:command-submit").setTitle(
    "Run a Minecraft command",
  )
    .addLabelComponents(
      new LabelBuilder().setLabel("Command").setDescription(
        "One command, without a leading /. Example: say Hello everyone",
      )
        .setTextInputComponent(
          new TextInputBuilder().setCustomId("command").setStyle(
            TextInputStyle.Short,
          ).setRequired(true).setMaxLength(4096),
        ),
    );
}
export function consoleButtons() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("console", "Refresh console"),
      button("command", "Run command", ButtonStyle.Primary),
    ),
  ];
}
export function restartButton() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("restart", "Restart to apply", ButtonStyle.Primary),
    ),
  ];
}
