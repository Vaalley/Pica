import { Client, Events, GatewayIntentBits } from "discord.js";
import { PicaApi } from "./api.ts";
import { Catalogs } from "./catalogs.ts";
import { createHandler } from "./handler.ts";
import { FileManager } from "./filemanager.ts";
import { Store } from "./store.ts";
import { DiscordRooms } from "./discord.ts";
import { Servers, TICK_MS } from "./service.ts";

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
const catalogs = new Catalogs();
const files = new FileManager(
  api,
  Deno.env.get("PICA_FILES_URL") ?? "http://127.0.0.1:8092",
  (ownerId) => servers.touch(ownerId),
);
servers.sessions = files;
const handle = createHandler(servers, guilds, catalogs, files);
client.once(Events.ClientReady, async (readyClient) => {
  try {
    for (const guildId of guilds) {
      const guild = await readyClient.guilds.fetch(guildId);
      await rooms.setup(guild);
      // Personal servers are button-driven; retire every slash command.
      for (const command of (await guild.commands.fetch()).values()) {
        await command.delete();
      }
    }
    const globalCommands = await readyClient.application.commands.fetch();
    for (const command of globalCommands.values()) await command.delete();
    servers.resume();
    setInterval(() => {
      void servers.maintain();
    }, TICK_MS);
    console.log(
      `Pica is online as ${readyClient.user.tag}; registered in ${guilds.size} configured guild(s).`,
    );
  } catch {
    console.error(
      "Pica setup failed. Check guild IDs, bot installation, and channel permissions.",
    );
    await client.destroy();
    Deno.exit(1);
  }
});
client.on(Events.InteractionCreate, async (interaction) => {
  if (
    !interaction.isButton() && !interaction.isModalSubmit() &&
    !interaction.isStringSelectMenu()
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
Deno.serve(
  {
    hostname: Deno.env.get("PICA_FILES_HOST") ?? "127.0.0.1",
    port: Number(Deno.env.get("PICA_FILES_PORT") ?? "8092"),
  },
  files.handler(),
);
try {
  await client.login(token);
} catch {
  console.error("Discord login failed. Check DISCORD_TOKEN and connectivity.");
  await client.destroy();
  Deno.exit(1);
}
