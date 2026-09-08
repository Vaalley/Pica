import { Client, Events, GatewayIntentBits } from "discord.js";
import { PicaApi } from "./api.ts";
import { commands } from "./commands.ts";
import { createHandler } from "./handler.ts";
import { Store } from "./store.ts";
import { DiscordRooms } from "./discord.ts";
import { Servers } from "./service.ts";

const token = Deno.env.get("DISCORD_TOKEN");
if (!token) throw new Error("Set DISCORD_TOKEN in .env before starting Pica.");
const guilds = new Set(
  (Deno.env.get("DISCORD_GUILD_IDS") ?? "").split(",").map((id) => id.trim())
    .filter(Boolean),
);
if (!guilds.size || [...guilds].some((id) => !/^\d{17,20}$/.test(id))) {
  throw new Error(
    "Set DISCORD_GUILD_IDS to a comma-separated list of authorized Discord server IDs.",
  );
}
const api = new PicaApi(
  Deno.env.get("PICA_URL") ?? "http://127.0.0.1:8091",
  Deno.env.get("PICA_SECRET") ?? "",
);
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
  allowedMentions: { parse: [] },
});
Deno.mkdirSync("data", { recursive: true });
const store = new Store("data/pica.sqlite");
const rooms = new DiscordRooms(client, store);
const servers = new Servers(store, api, rooms);
const handle = createHandler(servers, rooms, guilds);
client.once(Events.ClientReady, async (readyClient) => {
  try {
    for (const guildId of guilds) {
      const guild = await readyClient.guilds.fetch(guildId);
      for (const command of commands) {
        await guild.commands.create(command.toJSON());
      }
      // Retire the old administrator API command after the personal commands exist.
      for (const command of (await guild.commands.fetch()).values()) {
        if (command.name === "pica") await command.delete();
      }
    }
    // Remove the starter's obsolete global /pica after guild commands succeed.
    const globalCommands = await readyClient.application.commands.fetch();
    for (const command of globalCommands.values()) {
      if (command.name === "pica") await command.delete();
    }
    console.log(
      `Pica is online as ${readyClient.user.tag}; registered in ${guilds.size} configured guild(s).`,
    );
  } catch {
    console.error(
      "Failed to register Pica commands. Check guild IDs, bot installation, and applications.commands scope.",
    );
    await client.destroy();
    Deno.exit(1);
  }
});
client.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isChatInputCommand() && !interaction.isButton() &&
    !interaction.isModalSubmit()
  ) return;
  try {
    await handle(interaction);
  } catch {
    console.error("Failed to respond to Discord interaction.");
  }
});
client.on(
  Events.Error,
  () =>
    console.error(
      "Discord client error. Check connectivity and configuration.",
    ),
);
Deno.addSignalListener("SIGINT", () => {
  void client.destroy();
});
if (Deno.build.os !== "windows") {
  Deno.addSignalListener("SIGTERM", () => {
    void client.destroy();
  });
}
try {
  await client.login(token);
} catch {
  console.error("Discord login failed. Check DISCORD_TOKEN and connectivity.");
  await client.destroy();
  Deno.exit(1);
}
