import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
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
) {
  const embed = new EmbedBuilder().setColor(0x65c9a5).setTitle(
    "Your Minecraft server",
  )
    .setFooter({ text: `Pica · ${server.instanceId}` }).setTimestamp();
  if (server.phase === "provisioning") {
    embed.setDescription(
      "This is your private server channel. We’re setting up Minecraft.\n\nIf setup was interrupted or no slots were available, use **Finish setup** to try again.",
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button("retry", "Finish setup", ButtonStyle.Primary),
        ),
      ],
      allowedMentions: { parse: [] as never[] },
    };
  }
  if (server.phase === "deleting" || server.phase === "deleted") {
    embed.setDescription(
      "Server deletion needs to finish. Use **Finish deletion** to resume. This permanently removes the server files and this channel.",
    );
    return {
      embeds: [embed],
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          button("delete", "Finish deletion", ButtonStyle.Danger),
        ),
      ],
      allowedMentions: { parse: [] as never[] },
    };
  }
  embed.setDescription(
    [
      notice,
      "Use the buttons below to manage your server.\nFor files, use `/upload`, `/files`, or `/server-software` in this channel.",
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
          "Use `/files` to remove unneeded files. File management remains available.",
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
    ],
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
