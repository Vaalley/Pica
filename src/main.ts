import { Client, Events, GatewayIntentBits } from "discord.js";
import { PicaApi } from "./api.ts";
import { picaCommand } from "./commands.ts";
import { createHandler } from "./handler.ts";

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
const handle = createHandler(api, guilds);
client.once(Events.ClientReady, async (readyClient) => {
  try {
    for (const guildId of guilds) {
      const guild = await readyClient.guilds.fetch(guildId);
      await guild.commands.create(picaCommand.toJSON());
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
  if (!interaction.isChatInputCommand()) return;
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
