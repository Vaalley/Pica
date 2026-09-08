# Pica

Your own Minecraft server, managed from your own private Discord channel.

## How it works

1. Open **#create-a-server** and click **Create server**.
2. Accept the Minecraft EULA in the form.
3. Pica creates your Minecraft server and a private **#server-…** channel, then
   sends you a link to it.
4. Join using the address in your channel. Use its control panel to manage the
   server whenever you need to.

Each Discord user gets one Minecraft server and one private channel. Clicking
Create server again takes you back to that channel. If setup is interrupted,
**Finish setup** retries the same server without creating a second one.

## Your server channel

The control panel has **Start**, **Stop**, **Restart**, **Refresh**,
**Console**, **Files**, **Upload**, **Server software**, and **Delete server**
buttons.

Start prepares Minecraft for you to join. Restart asks for confirmation before
disconnecting players. Stop asks for confirmation and requires players to leave
first. Pica can automatically start Minecraft when someone connects, so Stop
does not prevent future connections from waking it up.

Console shows recent output and has a **Run command** button that opens a form.
Upload and Server software open a form where you attach the file directly, so
you never leave the channel. Files shows a current snapshot. The same actions
are available as commands in your own channel; you never need to enter a server
ID:

| Command                       | What it does                                                        |
| ----------------------------- | ------------------------------------------------------------------- |
| `/start`, `/stop`, `/restart` | Same actions as the panel buttons                                   |
| `/status`                     | Refresh the join address, storage usage, and connections            |
| `/panel`                      | Restore the control panel if its message was removed                |
| `/console`                    | Show recent output; optionally run a Minecraft command              |
| `/upload`                     | Attach a file and choose where it belongs on your server            |
| `/server-software`            | Attach your server JAR to install it as `boot.jar`                  |
| `/files`                      | Browse, download, copy, rename, and delete files, or create folders |
| `/delete-server`              | Confirm permanent deletion of your server and channel               |

For example, use `/upload` with a plugin JAR and the path
`plugins/MyPlugin.jar`. To replace the server software, use `/server-software`
with a JAR compatible with Java 25 and port 25565, then click Restart. This
version accepts a supplied JAR; it does not yet offer a Paper/Fabric version
catalog or automatic downloads.

Uploads ask you to confirm replacement. File deletion requires repeating the
path; server deletion requires typing `DELETE`. Pica may refuse deletion while
server resources are active; stop the server first. Deleting the Discord channel
manually does not delete Minecraft or its files—click Create server to restore
your channel.

## Running the bot

Use Deno 2 on the Pica host, where the private API listens on
`http://127.0.0.1:8091`. For development elsewhere, use a private tunnel to that
host.

Copy `.env.example` to `.env` if you don't already have one, then configure:

```dotenv
DISCORD_TOKEN=your-bot-token
DISCORD_GUILD_IDS=your-discord-guild-id
PICA_URL=http://127.0.0.1:8091
PICA_SECRET=your-backend-secret
```

Install the bot with the `bot` and `applications.commands` scopes. It needs
**Manage Channels**, **Manage Roles**, **View Channels**, **Send Messages**,
**Read Message History**, **Attach Files**, and **Embed Links**. Only the Guilds
gateway intent is used; no privileged intents are needed.

```sh
deno task check
deno task test
deno task start
```

Once it is online, a Discord administrator runs **`/setup`** once. This creates
**#create-a-server**, the welcome message with its button, and the private
**Minecraft servers** category. Running `/setup` again reuses the saved lobby
and message and restores them if removed. Members can then create their own
servers without administrator permission. `deno task dev` watches source
changes.

## Ownership and persistence

Only the owner and bot receive access to a private server channel. Discord
administrators can still see it because
[Administrator bypasses channel permission
overwrites](https://docs.discord.com/developers/topics/permissions). Bot actions
check ownership as well as the channel and guild; even an administrator cannot
operate another user's server through these controls.

Ownership, channel links, and lobby/message IDs are stored in
**`data/pica.sqlite`**. Keep this directory across deployments. Stop the bot
before backing up the entire `data` directory; it may include SQLite WAL files.
Run one bot process per database. Buttons remain usable after restarts, although
an open confirmation dialog expires after two minutes or a bot restart.

One server per user applies across all configured guilds. Backend instances
created outside this flow are not automatically assigned to users. Keep the
existing database: losing it loses the bot's ownership records, not the
Minecraft files. Startup removes the old `/pica` API command and registers the
personal commands.

## Limits and development

- Files are limited to 128 MiB by Pica; Discord's attachment limit may be lower.
- Server actions use a 180-second API timeout. Interrupted creation retains the
  reserved server and channel so it can be resumed safely.
- Connections count TCP sessions, including people still logging in. Panel data
  is refreshed on demand; the backend reports no online/offline lifecycle state.
- Configuration edits can require restarting even when no software-change
  warning is shown. File management remains available when storage is full.
- Secrets and the ownership database are ignored by Git. API errors are
  redacted; downloaded server files retain their original contents.

The tests cover API requests, member ownership, private permissions,
confirmations, duplicate creation, recovery, and database persistence using
simulated Discord and Pica responses. They make no network requests. Live
registration and provisioning still need testing against a running Discord bot
and Pica host.
