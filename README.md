<img src="assets/icon.svg" width="64" height="64" alt="">

# Mayfly

Mayfly is a fast front end to Maytas Hub for degree apprentices at the University of Chichester. You log your off-the-job (OTJ) training hours in Mayfly. Mayfly sends them to Maytas for you.

Maytas is slow, saves hang, and sessions end without warning. Mayfly saves each entry at once in its own store on your machine. A background job, the bridge, then signs in to Maytas with your username and password and sends the entry. It reads the Maytas grid back and marks the entry as confirmed only when it finds it there exactly once.

Mayfly also:

- imports your existing OTJ rows, your planned hours, end date, standard and KSB list,
- shows your hours against your target and the pace you need,
- reads your progress reviews, gives a "submit by" date five working days before each meeting, and makes a prep sheet from your entries since the last review,
- serves an MCP server, so an AI agent such as Claude Code can read your progress and log entries for you.

Each student runs their own copy. There is no cloud service. The only outside connection is from the bridge to Maytas.

Mayfly supports only the University of Chichester's Maytas. Its OTJ tab is a custom screen, and other universities have different ones.

## What Mayfly does to your Maytas account

Read this before you connect Mayfly to your real account.

- **Your hours are funding evidence.** The government funds your apprenticeship on the basis of these rows, and auditors read them. A wrong, duplicate or missing row matters. Maytas stays the official record. Your coach sees Maytas, not Mayfly.
- **Maytas allows one session per account.** When the bridge signs in, your own Maytas session in the browser ends. Turn on **Pause sync** while you use Maytas yourself.
- **The bridge signs in only when it must:** when an entry waits to be sent, once a day for a full check, and when you press **Sync now**. Each check reads one page of about 12 MB and takes about 10 seconds.
- **It uses your account automatically.** Maytas has no official API for learners, so the bridge uses the same pages as your browser. The university could object to this. The risk on your account is yours.
- **Tell your apprenticeship team that you use Mayfly** before you connect it to your account.

### How Mayfly protects your records

- **One write, then a check.** Every write submits the whole OTJ form, exactly as the browser's Save button does. All your other rows go back unchanged. The bridge never sends a write a second time without first reading the grid.
- **It stops when it is not sure.** If an entry appears twice in Maytas, has different text there, or vanishes from Maytas, the bridge stops and shows the entry under **Needs you**. You decide what to do.
- **It stops when Maytas looks different.** If a Maytas page does not look as expected, the bridge pauses, shows the reason and writes nothing.
- **It protects you from a lockout.** Two failed sign-ins in a row pause the bridge, so your account cannot lock. Fix the password, then press **Resume sync**.
- **It keeps deleted entries.** You can restore an entry that you deleted by mistake.
- **It logs everything.** The **Sync** page shows every action of the bridge, of you and of your agents.

### Where your password lives

Your Maytas password is only in the `.env` file on your own machine. Mayfly sends it only to Maytas, in the sign-in request. The web app and the MCP server cannot read it, so an agent cannot read it either. Anyone who can read files on your machine can read it, so keep the machine and the file private. Git ignores `.env`, so it does not go into a commit.

## Try it in fake mode first

Fake mode runs Mayfly against a built-in fake Maytas with sample data. It does not contact Maytas. Use it to learn the app before you connect your account.

The default settings in `.env.example` use fake mode. Follow the set-up below and do not change `MAYTAS_MODE` yet.

## Set up with Bun and pnpm

You need:

- [Bun](https://bun.sh) 1.3 or newer, to run Mayfly,
- [Node.js](https://nodejs.org) 22 or newer and [pnpm](https://pnpm.io), to install and build it,
- [Git](https://git-scm.com).

1. Get the code and install it:

   ```sh
   git clone https://github.com/JudahZF/mayfly.git
   cd mayfly
   pnpm install
   pnpm build
   ```

2. Make your settings file:

   ```sh
   cp .env.example .env
   ```

3. Start Mayfly:

   ```sh
   pnpm start
   ```

4. Open <http://127.0.0.1:4747> in your browser.

### Connect your real account

1. Tell your apprenticeship team that you use Mayfly.
2. Stop Mayfly (press `Ctrl+C` in its terminal).
3. Edit `.env`:

   ```sh
   MAYTAS_MODE=live
   MAYTAS_USERNAME=your-maytas-username
   MAYTAS_PASSWORD=your-maytas-password
   MAYFLY_DATA_DIR=./data
   ```

   Change `MAYFLY_DATA_DIR` to `./data`. This keeps your real data apart from the fake data. Never point live mode at the fake data folder: entries that you made in fake mode would go to Maytas.

4. Start Mayfly again with `pnpm start`.

At the first sync, Mayfly signs in, imports your existing rows and reads your profile. Your own Maytas session ends at that time. Check that the number of rows and the total hours in Mayfly match Maytas.

To update Mayfly later, stop it, run `git pull`, `pnpm install` and `pnpm build`, then start it again.

## Set up with Docker

You need [Docker](https://docs.docker.com/get-docker/) and Git.

In a container, Mayfly listens on all addresses inside the container, so it always requires an access token. Without `MAYFLY_TOKEN` it refuses to start.

1. Get the code and build the image:

   ```sh
   git clone https://github.com/JudahZF/mayfly.git
   cd mayfly
   docker build -t mayfly .
   ```

2. Make your settings file and add a token:

   ```sh
   cp .env.example .env
   openssl rand -hex 32
   ```

   Put the output of the second command after `MAYFLY_TOKEN=` in `.env`. Docker reads `.env` exactly as written, so do not put quotes around any value.

3. Start Mayfly in fake mode, with a volume for the fake data:

   ```sh
   docker run -d --init --name mayfly-fake -p 127.0.0.1:4747:4747 --env-file .env -v mayfly-fake:/data mayfly
   ```

4. Open <http://127.0.0.1:4747>. Mayfly asks for the token one time. Paste the `MAYFLY_TOKEN` value.

To connect your real account, tell your apprenticeship team first. Then remove the fake container and its data, set `MAYTAS_MODE=live`, `MAYTAS_USERNAME` and `MAYTAS_PASSWORD` in `.env`, and start a new container with its own volume:

```sh
docker rm -f mayfly-fake
docker volume rm mayfly-fake
docker run -d --init --name mayfly --restart unless-stopped -p 127.0.0.1:4747:4747 --env-file .env -v mayfly-data:/data mayfly
```

The image sets the address, the port and the data folder itself. It ignores `MAYFLY_HOST`, `MAYFLY_PORT` and `MAYFLY_DATA_DIR` from `.env`. The `-p 127.0.0.1:4747:4747` part makes Mayfly reachable only from your own machine.

To see what Mayfly does, run `docker logs mayfly`.

## Settings

All settings are in the `.env` file. `.env.example` has a comment for each one.

| Setting | Default | What it does |
| --- | --- | --- |
| `MAYTAS_MODE` | `fake` | `fake` uses the built-in fake Maytas. `live` uses your real account. |
| `MAYTAS_URL` | Chichester's Maytas | The Maytas address. Do not change it. |
| `MAYTAS_USERNAME` | empty | Your Maytas username. Required in live mode. |
| `MAYTAS_PASSWORD` | empty | Your Maytas password. Required in live mode. |
| `MAYFLY_HOST` | `127.0.0.1` | The address that Mayfly listens on. `127.0.0.1` means only this machine can reach it. Any other address requires `MAYFLY_TOKEN`. |
| `MAYFLY_PORT` | `4747` | The port of the web app and the MCP server. |
| `MAYFLY_TOKEN` | empty | The access token, at least 16 characters. Make one with `openssl rand -hex 32`. |
| `MAYFLY_DATA_DIR` | `./data-fake` | The folder for your data. Use `./data` for live mode. |

When `MAYFLY_TOKEN` is set, the web app asks for it one time on each device. MCP clients send it as the header `Authorization: Bearer <token>`.

If your password has a `#` or a `$` in it, take care:

- With Bun, `#` starts a comment and `$` reads another variable. Put the password in double quotes, and write each `$` as `\$`. For example, `MAYTAS_PASSWORD="ab#c\$d"`.
- With Docker, write the password exactly as it is, with no quotes and no `\`.

If the password is wrong, two failed sign-ins pause the bridge. Fix `.env`, restart Mayfly, then press **Resume sync**.

## Use Mayfly on your phone

Entries reach Maytas only while Mayfly runs. On a laptop, they wait in the queue until the next start. For your phone, run Mayfly on a machine that stays on, and reach it over a private network such as [Tailscale](https://tailscale.com).

1. Install Tailscale on that machine and on your phone, and sign in on both.
2. Set `MAYFLY_TOKEN` in `.env`. Keep `MAYFLY_HOST=127.0.0.1`. Tailscale forwards requests from your other devices to Mayfly, so Mayfly must check a token. Restart Mayfly.
3. On the machine, run:

   ```sh
   tailscale serve --bg --https=4747 http://127.0.0.1:4747
   ```

4. On your phone, open `https://<machine-name>.<tailnet-name>.ts.net:4747` and enter the token one time. Run `tailscale serve status` to see the exact address.

Do not use Tailscale Funnel. Funnel puts Mayfly on the public internet.

## Connect an AI agent

Mayfly serves an MCP server at `http://127.0.0.1:4747/mcp` (Streamable HTTP). The **Settings** page has a button to copy the address.

For Claude Code, run:

```sh
claude mcp add --transport http mayfly http://127.0.0.1:4747/mcp
```

If `MAYFLY_TOKEN` is set (always true with Docker), add the token as a header:

```sh
claude mcp add --transport http mayfly http://127.0.0.1:4747/mcp --header "Authorization: Bearer <token>"
```

In T3 Code, add the same address, and the same header if you use a token, as an HTTP MCP server. Cloud clients such as claude.ai cannot reach an address on your machine.

The agent can read your progress, entries, KSBs and review prep, and it can add entries. On the **Settings** page you choose the agent mode:

| An agent can | Drafts (default) | Full access |
| --- | --- | --- |
| Read progress, entries, KSBs and review prep | Yes | Yes |
| Add entries | As drafts. You approve each one. | Yes. They go to Maytas at once. |
| Change or delete a draft | Yes | Yes |
| Approve drafts | No | Yes |
| Change or delete an entry that is in Maytas | No | Yes |
| Change the mode, read your password, sign a review or talk to Maytas | No | No |

An entry from an agent goes through the same checks as an entry from you. While full access is on, the app shows "Agents have full access" below the sync status. Start with drafts mode. An agent in full access can write wrong evidence to Maytas.

## Stop Mayfly or pause sync

- **Pause sync:** open the **Sync** page and turn on **Pause sync**. The bridge then does not sign in to Maytas. New entries wait in the queue. Turn it off again when you finish in Maytas.
- **Stop Mayfly:** press `Ctrl+C` in its terminal, or run `docker stop mayfly`. Entries that wait in the queue go to Maytas at the next start. A stop in the middle of a write is safe: at the next start, the bridge first checks the grid.
- **Start it again:** run `pnpm start`, or `docker start mayfly`.

## Your data and backups

Mayfly keeps all your data in one SQLite file, `mayfly.db`, in the data folder:

- With Bun and pnpm: the folder in `MAYFLY_DATA_DIR` (`./data` in live mode).
- With Docker: the `mayfly-data` volume.

Next to `mayfly.db` there can be `mayfly.db-wal` and `mayfly.db-shm` files. They hold recent changes. To make a backup, stop Mayfly first, then copy the whole folder:

```sh
# Bun and pnpm
cp -r data mayfly-backup

# Docker
docker stop mayfly
docker cp mayfly:/data ./mayfly-backup
docker start mayfly
```

To restore, stop Mayfly and put the copied files back in the data folder.

The **Settings** page also has a CSV export of all your entries, deleted ones included.

## For developers

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Starts the server with Bun in watch mode, and the Vite dev server. Vite sends `/api` and `/mcp` to the server. |
| `pnpm build` | Builds the web app into `dist/web`. The server serves it from there. |
| `pnpm start` | Starts the server. |
| `pnpm test` | Runs the tests with `bun test`. |
| `pnpm typecheck` | Runs `tsc --noEmit`. |
| `pnpm db:generate` | Makes a Drizzle migration in `drizzle/` after a change to `src/server/db/schema.ts`. The server applies new migrations at start. |

Bun reads `.env` by itself. The settings are checked in `src/server/env.ts`.

### Layout

- `src/shared/` holds the zod schema for an entry. The form, the API and the MCP tools all use it.
- `src/server/` holds the Bun and Hono server:
  - `index.ts` starts the store, the bridge and the HTTP server, and serves the web app.
  - `api.ts` has the typed routes for the web app and the access check for `/api` and `/mcp`.
  - `mcp.ts` has the MCP tools.
  - `entries.ts` is the only code that changes entries. The app and MCP both call it, and it applies the agent mode.
  - `outbox.ts` and `bridge.ts` are the sync loop: write once, read back, pause when in doubt.
  - `reviews.ts` has the progress reviews and the prep sheet.
  - `db/` has the Drizzle tables and opens the SQLite store.
- `src/maytas/` is the only code that talks to Maytas. `http.ts` is the real client, `fake.ts` is the fake with fault injection for tests and fake mode, and `types.ts` is the interface between them and the server.
- `src/web/` is the React web app (Vite, TanStack Router, TanStack Query).
- `drizzle/` holds the SQL migrations.

### Tools

- `tools/probe-maytas.ts` maps Maytas pages for development. It is read-only: it signs in with the credentials in `.env`, fetches each path that you give with GET, saves the replies to `capture/live/`, then signs out. Git ignores `capture/`, because the pages hold personal data.

  ```sh
  bun tools/probe-maytas.ts /etrack/Home
  ```

- `tools/scrub-har.ts` removes secrets (password, cookies, tokens) from a browser HAR export of a Maytas session. Page content stays, so the output still holds personal data.

  ```sh
  bun tools/scrub-har.ts <path-to-har> --out capture/scrubbed
  ```

Never commit anything from `capture/`, `data/` or `data-fake/`. Test fixtures must use made-up data.

## Licence

MIT. See [LICENSE](LICENSE). Mayfly comes with no warranty: check your records in Maytas, because they are your funding evidence.
