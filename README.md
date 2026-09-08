# Pica

A Deno + Discord.js bot for administering Pica Minecraft servers through slash
commands. Implements the attached Pica API handoff with server-side
authentication, private replies, console access, and file management.

## Setup

1. Install Deno 2. The project uses Discord.js 14, pinned by `deno.lock`.
2. Install your Discord application in the target server with the `bot` and
   `applications.commands` scopes. Only the Guilds gateway intent is needed; no
   Message Content or other privileged intents are required.
3. Copy `.env.example` to `.env` if you do not already have one. Set:
   - `DISCORD_TOKEN`: your bot token.
   - `DISCORD_GUILD_IDS`: comma-separated Discord server IDs allowed to use
     Pica.
   - `PICA_URL`: defaults to `http://127.0.0.1:8091`.
   - `PICA_SECRET`: the backend's configured secret, at least 32 characters.
4. Run `deno task check` and `deno task test`, then `deno task start`. Use
   `deno task dev` for automatic restarts during development.

Run the bot on the Pica host so it can reach the loopback API. For development
on a different computer, use a private tunnel to that host and configure
`PICA_URL` accordingly. Keep the Pica API private. Do not paste secrets into
Discord.

Startup registers `/pica` in each configured guild and removes the starter's old
global `/pica` command. Other application commands are preserved. No API
requests are made until an authorized user invokes a command.

## Access model

Only members with Discord's **Administrator** permission in a configured guild
can use the bot. The handler checks this on every invocation, in addition to the
command's default permissions. DMs and other guilds are denied. All authorized
administrators share access to **all instances on the configured Pica backend**;
there is no per-user or per-guild ownership model in this first implementation.

Replies and downloads are ephemeral. Mentions are disabled. Secrets remain in
the bot process and are redacted from API error diagnostics and console text.
Downloaded files retain their original binary contents, so treat them as
sensitive.

## Commands

| Command                                               | Purpose                                                 |
| ----------------------------------------------------- | ------------------------------------------------------- |
| `/pica help`                                          | Quick usage guide                                       |
| `/pica list [page]`                                   | List servers and current capacity                       |
| `/pica create id accept-eula`                         | Create with explicit Minecraft EULA acceptance          |
| `/pica status id`                                     | Hostname, TCP connections, storage and restart warnings |
| `/pica prepare id`                                    | Explicitly ensure Minecraft is ready                    |
| `/pica restart id [confirm-disconnect]`               | Restart; confirm when connections exist                 |
| `/pica delete id confirm-id`                          | Permanently delete the server and all files             |
| `/pica tail id [lines]`                               | Latest 1–1,000 console lines (default 20)               |
| `/pica run id command`                                | Execute one administrator console command               |
| `/pica files list id [path] [page]`                   | Directory listing; root by default                      |
| `/pica files stat id path`                            | Size, permissions, modification time and type           |
| `/pica files read id path`                            | Download a regular file                                 |
| `/pica files write id path file confirm-replace`      | Upload/replace a file                                   |
| `/pica files mkdir id path`                           | Create directories                                      |
| `/pica files rename id path destination`              | Move or rename                                          |
| `/pica files copy id path destination [recursive]`    | Copy files/directories                                  |
| `/pica files delete id path confirm-path [recursive]` | Permanently delete files/directories                    |
| `/pica files chmod id path mode`                      | Set octal permissions, e.g. `644` or `0755`             |

Examples:

```text
/pica create id:survival accept-eula:true
/pica status id:survival
/pica run id:survival command:say Hello from Discord
/pica files list id:survival path:plugins
/pica restart id:survival confirm-disconnect:true
```

Accepting the EULA is an explicit user choice; review the
[Minecraft EULA](https://www.minecraft.net/eula) before setting
`accept-eula:true`. Connect using the returned hostname. Normal player
connections prepare Minecraft automatically; backend state is neither displayed
nor used to select actions. There is no normal stop command. `/pica run`
intentionally grants full Minecraft console access to authorized administrators.

Server deletion requires repeating the exact ID in `confirm-id`; file deletion
requires repeating the exact input path in `confirm-path`, including for
recursive deletion. These command options are the confirmation UI. Restart
checks current TCP connections before requiring `confirm-disconnect:true`.
Connections can change between that check and the restart. Pica may refuse
deletion with HTTP 409; check status and retry when the backend conflict clears.

## Behavior and limits

- API requests use POST and a 180-second timeout, with no automatic retries of
  mutations. A timeout may leave an operation running on Pica; inspect status or
  files before retrying.
- Discord requests are acknowledged immediately with an ephemeral deferred
  reply. Discord requires acknowledgment within 3 seconds and supports
  follow-ups for 15 minutes. See
  [Discord interaction documentation](https://docs.discord.com/developers/interactions/receiving-and-responding).
- Mutations on the same instance cannot overlap inside one bot process. Run one
  bot process per configuration; these locks do not coordinate multiple
  processes or other API clients.
- Console and status commands return snapshots; invoke again to refresh. Large
  console output is attached as text or explicitly truncated if it exceeds
  Discord's transfer limit. Lists support pagination.
- Reads and uploads are bounded to 128 MiB, and downloads also respect Discord's
  per-interaction attachment limit. Actual streamed bytes are checked, not just
  declared sizes. Discord upload limits may be lower than Pica's limit.
- Uploads use binary multipart parts in `secret`, `path`, `file` order. Only
  Discord attachment URLs are fetched, with redirects disabled. Uploads replace
  the target atomically through Pica; missing parents are created by the
  backend.
- Paths are relative and use `/`. Parent traversal, absolute paths and
  destructive root operations are rejected. Copy destinations must not exist;
  directory copy needs `recursive:true`. Pica enforces the 128 MiB copy limit.
- A runnable JAR must be named `boot.jar`, support Java 25, and listen on port
  25565. Uploading it prompts a restart. Other config edits can require
  restarting even when the API's `restartRequired` flag is false.

Tests use mocked HTTP and Discord interactions, require no credentials, and have
no network permission. Live Discord registration and Pica behavior require a
configured environment and are not exercised by the test suite.
