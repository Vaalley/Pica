# Pica

Your own Minecraft server, managed from your own private Discord channel.

## How it works

1. Open **#create-a-server** and click **Create server**.
2. Accept the Minecraft EULA in the form.
3. Pica creates your Minecraft server and a private channel named after it (e.g.
   **#wild-willow**), then sends you a link to it.
4. Manage everything from three auto-updating messages in your channel — there
   are no commands and no refresh buttons.

Each Discord user gets one Minecraft server and one private channel. New servers
get a readable two-word address like `wild-willow`.

## Temporary channels

Server channels expire **one hour after your last interaction** — any button,
form, or file manager use resets the clock. When a channel expires it is
deleted; your server and its files are untouched. Click **Open existing** in
#create-a-server to bring the channel back at any time.

## Your server channel

Three messages update automatically every minute:

- **Console** — recent server output, with a **Run command** button.
- **Server status** — online/offline state, join address, TCP sessions, and
  storage. Shows **Start** when the server is off, **Stop** and **Restart** when
  it is on.
- **Additional actions** — everything else:

| Button                    | What it does                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **File Manager**          | Opens FileBrowser Quantum through the bot's authenticated gateway. The link carries a random token and dies with the channel.     |
| **Install mod or plugin** | Searches Modrinth (mods) or Hangar + SpigotMC (plugins) matching your software, then downloads and installs the file.             |
| **Change software**       | Pick Vanilla, Paper, Purpur, or Fabric and a version; the server JAR is downloaded and installed as `boot.jar`. Restart to apply. |
| **Change IP**             | Choose the subdomain of your join address.                                                                                        |
| **Delete server**         | Permanently deletes the server, its files, and the channel after a typed confirmation.                                            |

Stop and Restart ask for confirmation before disconnecting players. Pica can
automatically start Minecraft when someone connects, so Stop does not prevent
future connections from waking it up.

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
PICA_FILES_URL=https://fs.example.com
PICA_FILES_PORT=8092
PICA_FILES_HOST=127.0.0.1
PICA_FILEBROWSER_URL=http://127.0.0.1:8080
PICA_FILEBROWSER_BRIDGE_KEY=at-least-32-random-characters
PICA_FILEBROWSER_BRIDGE_HOST=127.0.0.1
PICA_FILEBROWSER_BRIDGE_PORT=8093
```

`PICA_FILES_URL` is the public origin members use to reach FileBrowser. The bot
first validates its temporary `/f/<token>` URL, then writes an HttpOnly session
cookie and proxies the request to `PICA_FILEBROWSER_URL`. Configure FileBrowser
with its root `baseURL` and disable its own browser login; it is never publicly
reachable directly.

The bot sends the active session identifier to FileBrowser in
`X-Pica-File-Session`. FileBrowser must forward that header unchanged, together
with `X-Pica-Filebrowser-Bridge-Key`, to the private bridge at
`http://PICA_FILEBROWSER_BRIDGE_HOST:PICA_FILEBROWSER_BRIDGE_PORT/v1/fs/*`. The
bridge is loopback-only by default, resolves the instance from the active
session, and calls Pica with the bot-held backend secret. Generate a distinct
`PICA_FILEBROWSER_BRIDGE_KEY` with at least 32 characters; it is a
service-to-service credential, not a browser credential.

`PICA_FILES_PORT` is the public gateway bind port. `PICA_FILES_HOST` defaults to
`127.0.0.1` — set it to `0.0.0.0` only behind a TLS reverse proxy. Keep
`PICA_FILEBROWSER_BRIDGE_HOST` loopback-only.

The vendored FileBrowser fork is configured by `filebrowser/pica.config.yaml`.
It disables WebDAV and indexing, exposes only the `Pica` virtual source, and
uses the filesystem bridge instead of its configured placeholder path for core
browse, upload, download, edit, folder creation, move, copy, delete, and mode
changes. Build and run it on the same private network as the bot:

Archive creation, search, duplicate detection, filesystem watching, WebDAV,
media metadata, and share routes remain disabled because their upstream
implementations access a configured local source directly.

```sh
cd filebrowser/frontend && npm ci && npm run build
cd ../backend && go build -o pica-filebrowser .
PICA_FILEBROWSER_BRIDGE_URL=http://127.0.0.1:8093 \
PICA_FILEBROWSER_BRIDGE_KEY="$PICA_FILEBROWSER_BRIDGE_KEY" \
  ./pica-filebrowser --config ../pica.config.yaml --no-input
```

Mount persistent writable directories at `/var/lib/filebrowser` and
`/var/cache/filebrowser`. The FileBrowser listener remains `127.0.0.1:8094`; set
`PICA_FILEBROWSER_URL=http://127.0.0.1:8094` for the bot gateway.

Install the bot with the `bot` and `applications.commands` scopes. It needs
**Manage Channels**, **Manage Roles**, **View Channels**, **Send Messages**,
**Read Message History**, **Attach Files**, and **Embed Links**. Only the Guilds
gateway intent is used; no privileged intents are needed.

```sh
deno task check
deno task test
deno task start
```

On startup the bot creates **#create-a-server**, its welcome message, and the
private **Minecraft servers** category in every configured guild — no `/setup`
command is needed. Startup also deletes any registered slash commands; every
control is a button, form, or menu. `deno task dev` watches source changes.

## Ownership and persistence

Only the owner and bot receive access to a private server channel. Discord
administrators can still see it because
[Administrator bypasses channel permission
overwrites](https://docs.discord.com/developers/topics/permissions). Bot actions
check ownership as well as the channel and guild; even an administrator cannot
operate another user's server through these controls.

Ownership, channel and message links, lobby IDs, chosen software, and join
addresses are stored in **`data/pica.sqlite`**. Keep this directory across
deployments. Stop the bot before backing up the entire `data` directory; it may
include SQLite WAL files. Run one bot process per database. Buttons remain
usable after restarts, although an open confirmation dialog expires after two
minutes.

One server per user applies across all configured guilds. Backend instances
created outside this flow are not automatically assigned to users. Keep the
existing database: losing it loses the bot's ownership records, not the
Minecraft files.

## Limits and development

- Files are limited to 128 MiB by Pica; the file manager enforces the same cap.
- Server actions use a 180-second API timeout. Interrupted creation retains the
  reserved server and channel so it can be resumed safely.
- Connections count TCP sessions, including people still logging in. The backend
  reports no online/offline lifecycle state; the status message infers it from
  console availability (a 502 from the log tail means offline).
- Change IP currently stores the chosen subdomain locally and displays it as the
  join address; it is not yet pushed to the backend.
- Forge and NeoForge are not offered: their installers must be executed, which
  the file API cannot do. CurseForge is not a source (its API needs a key).
- Secrets and the ownership database are ignored by Git. API errors are
  redacted; downloaded server files retain their original contents.

The tests cover API requests, member ownership, private permissions,
confirmations, duplicate creation, channel expiry and recovery, catalog
resolution, the file manager, and database persistence using simulated Discord
and Pica responses. They make no network requests. Live registration and
provisioning still need testing against a running Discord bot and Pica host.
