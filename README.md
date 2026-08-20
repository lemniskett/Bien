# Bien 🐈‍⬛

A general-purpose life-management Discord bot with the personality of an unenthusiastic
Japanese black cat. You just talk to it — "@Bien remind me to drink water at 5 AM",
"@Bien every day at 7 tell me a quote", "@Bien I spent 50k on lunch" — and an AI CLI
(`claude` or `codex`) decides what to do and remembers it.

## How it works

The backend is deliberately thin. It provides only two things the AI can't do alone:

1. **A conversational relay.** Every mention is forwarded to the AI CLI, which reads
   `workspace/AGENTS.md`, interprets your intent, reads/writes files in `workspace/`,
   and replies. All free-form memory (expenses, notes, lists, journals) is just Markdown
   the AI invents — no backend code per feature.
2. **A time-based delivery engine.** A scheduler polls every minute and drives two
   structured item types the AI creates via the `bien` CLI:
   - **reminders** — fire once, then nag every 5 min (up to 12×) until you click
     **Acknowledge**.
   - **schedules** — recurring cron jobs ("every day at 7 AM") that fire on cadence with
     no acknowledgment; each either posts a fixed message or re-runs the AI.

The AI never hand-writes JSON. It calls `bien reminder add|update …` /
`bien schedule add|update …`, which validate input, resolve who to tag, and manage the files.

## Setup

### 1. Create the Discord app
In the [Discord Developer Portal](https://discord.com/developers/applications):
- **New Application** → **Bot** → **Reset Token**, copy it.
- Under **Bot → Privileged Gateway Intents**, enable **MESSAGE CONTENT INTENT** and
  **SERVER MEMBERS INTENT** (both required).
- **OAuth2 → URL Generator**: scope `bot`; permissions **Send Messages**,
  **Read Message History**, **Mention Everyone**. Open the URL to invite Bien to your
  server.

### 2. Make sure your AI CLI works
The machine running Bien must have a logged-in `claude` **or** `codex` on its `PATH`:
```bash
claude --version   # or: codex --version
```
Bien shells out to it, so it uses whatever account that CLI is authenticated with.

### 3. Configure and run
```bash
npm install
cp .env.example .env      # then edit .env
npm start
```

Required `.env` values (no defaults — the bot refuses to start without them):

| Var | Example | Meaning |
|-----|---------|---------|
| `DISCORD_TOKEN` | `Mzk…` | Bot token |
| `AI_CLI` | `claude` | `claude` or `codex` |
| `AI_MODEL` | `haiku` | Model passed to the CLI |
| `TIMEZONE_OFFSET` | `UTC+7` | Fixed offset used to turn "5 AM" into an absolute time |

Optional tuning: `WORKSPACE_DIR`, `POLL_INTERVAL_MS`, `NAG_INTERVAL_MS`, `NAG_MAX`,
`AI_TIMEOUT_MS` (see `.env.example`).

## Usage examples

```
@Bien remind me to drink water in 20 minutes
@Bien remind everyone about dinner at 7pm
@Bien every day at 7am tell me a short motivational quote
@Bien every 2 hours say: stand up and stretch
@Bien I spent 50k on lunch today
@Bien what did I spend this week?
```

To stop a nagging reminder, click the **Acknowledge ✅** button on the ping.

## The `bien` CLI (what the AI drives)

You can also run it yourself for inspection/testing:

```bash
npm run bien -- list
npm run bien -- reminder add --text "test" --due 2026-01-01T00:00:00Z
npm run bien -- reminder update <id> --due 2026-01-02T00:00:00Z
npm run bien -- schedule add --title t --cron "0 7 * * *" --action-type message --action "hi"
npm run bien -- schedule update <id> --cron "0 8 * * *"
npm run bien -- roster list
```

`update` patches an existing item in place — only the flags you pass change. Rescheduling a
reminder's `--due` restarts its nag cycle; a new `--cron` re-derives the next fire time.
Use it instead of adding a replacement, or the original keeps firing alongside the new one.

Discord ids come from `BIEN_USER_ID` / `BIEN_CHANNEL_ID` / `BIEN_GUILD_ID` env vars
(the bot injects these per message), or `--user/--channel/--guild` overrides.

## Layout

```
src/
  index.js            entry: start bot + scheduler
  config.js           env loading + validation
  cli/bien.js         the AI's validated write interface
  reminders/          reminder store
  schedules/          schedule store + cron evaluation
  ai/                 claude/codex adapters, session persistence, per-channel queue
  discord/            client, roster sync, message handler, ping/ack notifier
  scheduler.js        the 60s poll loop
  roster.js           name → id resolution
workspace/            the AI's home — runs here
  AGENTS.md           committed operating contract (edit this to change behavior/persona)
  INDEX.md            the AI's memory map (committed starter; AI appends to it)
  *.md                flat Markdown memory the AI writes (expenses.md, shopping.md, …)
  reminders/ schedules/ uploads/   backend/bien-managed
data/                 bot-owned state (sessions.json, roster.json)
```

To change Bien's behavior or persona, edit `workspace/AGENTS.md` and restart — it's a plain
committed file, no build step. One catch: `AGENTS.md` is injected when a channel's AI
session is first bootstrapped, and sessions persist in `data/sessions.json` across restarts.
An already-running conversation keeps the old contract, so delete `data/sessions.json` (or
just the affected channel's entry) to make the change take effect immediately.

## Safety note

Bien runs the AI CLI with permissions bypassed (`--dangerously-skip-permissions` /
`--dangerously-bypass-approvals-and-sandbox`), scoped to `workspace/` as its working
directory. Run it on a machine you trust, for a server you control.
