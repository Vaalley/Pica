import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  LabelBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { type Instance } from "./api.ts";
import { bytes, code } from "./common.ts";
import { type Server } from "./store.ts";

const COLOR = 0x65c9a5;
function button(action: string, label: string, style = ButtonStyle.Secondary) {
  return new ButtonBuilder().setCustomId(`pica:${action}`).setLabel(label)
    .setStyle(style);
}
function marker(server: Server, part: string) {
  return `Pica · ${server.instanceId} · ${part}`;
}
const silent = { allowedMentions: { parse: [] as never[] } };

export function lobbyPanel() {
  return {
    embeds: [
      new EmbedBuilder().setColor(COLOR).setTitle(
        "Your own Minecraft server",
      )
        .setDescription(
          "Create your server and get a private channel to manage it.\n\n" +
            "One server per person. Channels expire one hour after you last use them — " +
            "**Open existing** brings yours back with everything intact.",
        )
        .addFields({
          name: "Before you create",
          value:
            "You'll be asked to accept the [Minecraft EULA](https://www.minecraft.net/eula).",
        })
        .setFooter({ text: "Pica · Personal Minecraft hosting" }),
    ],
    components: [
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        button("create", "Create server", ButtonStyle.Success),
        button("open", "Open existing"),
      ),
    ],
    ...silent,
  };
}

const CONSOLE_TEXT_LIMIT = 4000;
function consoleText(lines: string[]): string {
  const selected: string[] = [];
  let length = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].replaceAll("```", "ˋˋˋ");
    const available = CONSOLE_TEXT_LIMIT - length - (selected.length ? 1 : 0);
    if (available <= 0) break;
    selected.push(line.slice(-available));
    length += Math.min(line.length, available) + (selected.length > 1 ? 1 : 0);
    if (line.length > available) break;
  }
  return selected.reverse().join("\n");
}

export function consoleMessage(server: Server, lines?: string[], busy = false) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle("Console")
    .setFooter({ text: marker(server, "console") }).setTimestamp();
  const text = lines === undefined
    ? "Console unavailable."
    : lines.length
    ? `\`\`\`text\n${consoleText(lines)}\n\`\`\``
    : "No console output yet.";
  embed.setDescription(text);
  return {
    embeds: [embed],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("command", "Run command", ButtonStyle.Primary).setDisabled(busy),
    )],
    ...silent,
  };
}

export function statusMessage(
  server: Server,
  instance?: Instance,
  online?: boolean,
  notice?: string,
  busy = false,
) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle("Server status")
    .setFooter({ text: marker(server, "status") }).setTimestamp();
  const row = new ActionRowBuilder<ButtonBuilder>();
  if (server.phase === "provisioning") {
    embed.setDescription(
      notice ??
        "This is your private server channel. Use **Finish setup** to continue creating your Minecraft server.",
    );
    row.addComponents(
      button(
        "retry",
        busy ? "Creating server…" : "Finish setup",
        ButtonStyle.Primary,
      ).setDisabled(busy),
    );
    return { embeds: [embed], components: [row], ...silent };
  }
  if (server.phase === "deleting" || server.phase === "deleted") {
    embed.setDescription(
      notice ??
        "Server deletion needs to finish. Use **Finish deletion** to resume. This permanently removes the server files and this channel.",
    );
    row.addComponents(
      button(
        "delete",
        busy ? "Deleting…" : "Finish deletion",
        ButtonStyle.Danger,
      ).setDisabled(busy),
    );
    return { embeds: [embed], components: [row], ...silent };
  }
  embed.setDescription(
    [
      notice,
      busy ? "Please wait. This can take up to three minutes." : null,
    ].filter(Boolean).join("\n\n") || null,
  );
  embed.addFields(
    {
      name: "State",
      value: online === undefined ? "Unknown" : online ? "Online" : "Offline",
      inline: true,
    },
    {
      name: "Address",
      value: code(server.hostname ?? instance?.hostname ?? "pending"),
      inline: true,
    },
    {
      name: "Connections",
      value: `${instance?.connections ?? 0} TCP sessions`,
      inline: true,
    },
    {
      name: "Storage",
      value: `${bytes(instance?.usedBytes ?? 0)} / ${
        bytes(instance?.storageLimitBytes ?? 0)
      }`,
      inline: true,
    },
  );
  if (instance?.storageBlocked) {
    embed.addFields({
      name: "⚠️ Storage is full",
      value: "Open **File Manager** below to delete unneeded files.",
    });
  }
  if (instance?.restartRequired) {
    embed.addFields({
      name: "Restart needed",
      value: "Your server software changed. Click Restart to apply it.",
    });
  }
  if (online === false) {
    row.addComponents(button("start", "Start", ButtonStyle.Success));
  } else if (online === true) {
    row.addComponents(
      button("stop", "Stop"),
      button("restart", "Restart", ButtonStyle.Primary),
    );
  } else {
    row.addComponents(
      button("start", "Start", ButtonStyle.Success),
      button("stop", "Stop"),
      button("restart", "Restart", ButtonStyle.Primary),
    );
  }
  for (const component of row.components) component.setDisabled(busy);
  return { embeds: [embed], components: [row], ...silent };
}

export function actionsMessage(
  server: Server,
  fileManagerUrl?: string,
  busy = false,
) {
  const embed = new EmbedBuilder().setColor(COLOR).setTitle(
    "Additional actions",
  ).setFooter({ text: marker(server, "actions") });
  if (server.phase !== "ready") {
    embed.setDescription("Available once your server is ready.");
    return { embeds: [embed], components: [], ...silent };
  }
  const row = new ActionRowBuilder<ButtonBuilder>();
  embed.setDescription(
    "Files, server software, and your join address. " +
      "The file manager link works until this channel expires.",
  );
  if (fileManagerUrl) {
    row.addComponents(
      new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(fileManagerUrl)
        .setLabel("File Manager"),
    );
  }
  if (server.software === "fabric") {
    row.addComponents(button("install", "Install mod"));
  } else if (server.software === "paper" || server.software === "purpur") {
    row.addComponents(button("install", "Install plugin"));
  } else if (server.software !== "vanilla") {
    row.addComponents(button("install", "Install mod or plugin"));
  }
  row.addComponents(
    button("software", "Change software"),
    button("ip", "Change IP"),
    button("delete", "Delete server", ButtonStyle.Danger),
  );
  for (const component of row.components) {
    if (component.data.style !== ButtonStyle.Link) component.setDisabled(busy);
  }
  return { embeds: [embed], components: [row], ...silent };
}

export function inputModal(
  customId: string,
  title: string,
  field: string,
  label: string,
  description: string,
  placeholder: string,
  maxLength = 100,
) {
  return new ModalBuilder().setCustomId(customId).setTitle(title)
    .addLabelComponents(
      new LabelBuilder().setLabel(label).setDescription(description)
        .setTextInputComponent(
          new TextInputBuilder().setCustomId(field).setStyle(
            TextInputStyle.Short,
          ).setPlaceholder(placeholder).setRequired(true)
            .setMaxLength(maxLength),
        ),
    );
}

export function consoleModal() {
  return inputModal(
    "pica:command-submit",
    "Run a Minecraft command",
    "command",
    "Command",
    "One command, without a leading /. Example: say Hello everyone",
    "say Hello everyone",
    4000,
  );
}

export function softwareSelect() {
  return {
    content: "Choose your new server software. This replaces boot.jar.",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId("pica:software-pick")
          .setPlaceholder("Server software")
          .addOptions(
            {
              label: "Vanilla",
              value: "vanilla",
              description: "Official Mojang server",
            },
            {
              label: "Paper",
              value: "paper",
              description: "Plugins, high performance",
            },
            {
              label: "Purpur",
              value: "purpur",
              description: "Paper fork with extra settings",
            },
            {
              label: "Fabric",
              value: "fabric",
              description: "Lightweight mod loader",
            },
          ),
      ),
    ],
  };
}

export function versionSelect(
  software: string,
  name: string,
  versions: string[],
) {
  return {
    content: `Choose a ${name} version.`,
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(
          `pica:version-pick:${software}`,
        ).setPlaceholder("Minecraft version")
          .addOptions(
            versions.slice(0, 25).map((v) => ({ label: v, value: v })),
          ),
      ),
    ],
  };
}

export function addonSelect(
  token: string,
  results: { name: string; description: string; downloads: number }[],
) {
  return {
    content: "Choose what to install.",
    components: [
      new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
        new StringSelectMenuBuilder().setCustomId(`pica:addon-pick:${token}`)
          .setPlaceholder("Search results")
          .addOptions(
            results.slice(0, 25).map((r, i) => ({
              label: r.name.slice(0, 100),
              value: String(i),
              description:
                `${r.description} · ${r.downloads.toLocaleString()} downloads`
                  .slice(0, 100),
            })),
          ),
      ),
    ],
  };
}

export function restartButton() {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      button("restart", "Restart to apply", ButtonStyle.Primary),
    ),
  ];
}
