# Deployment

This guide is for the person who runs the bot. It assumes you know Docker Compose and the Discord Developer Portal.

## Requirements

- A Linux host with Docker and Docker Compose.
- `compose.yaml` and `.env.example` from this repository.
- A Discord application with a bot user.
- Access to the private image `ghcr.io/vatnz-dev/booking-bot`. Log in to `ghcr.io` with a token that has `read:packages`.

## Discord setup

1. Create the application and its bot user. Keep the bot token for `DISCORD_TOKEN`.
2. Turn on **Message Content Intent**. Login fails without it.
3. Invite the bot with the scopes `bot` and `applications.commands`:

   ```text
   https://discord.com/oauth2/authorize?client_id=<APP_ID>&scope=bot+applications.commands&permissions=326417607744
   ```

   Use `permissions=326417738816` if the pinged roles are not mentionable by everyone. This adds **Mention @everyone, @here and All Roles**.

| Permission               | Used for                                            |
| ------------------------ | --------------------------------------------------- |
| View Channels            | Booking channel, log channel, event threads         |
| Send Messages            | Bookings, booking panel, audit posts, event prompts |
| Embed Links              | All posts are embeds                                |
| Read Message History     | Find the booking panel and booking posts            |
| Add Reactions            | Add 👍 to bookings that need a mentor               |
| Manage Messages          | Clear 👍 reactions after approval                   |
| Create Public Threads    | Event threads                                       |
| Send Messages in Threads | Bookings in event threads                           |
| Manage Threads           | Rename and delete event threads                     |

The bot must have these permissions in the booking channel and the log channel. The booking channel must be a text channel, because event threads are created in it.

## Settings

Fill in `.env` from `.env.example`. Replace every placeholder, and leave a setting blank if you don't use it. The bot reads a placeholder as a real value, so a placeholder `GUILD_ID` makes the bot leave your server.

Lists are comma-separated IDs. To apply a change to `.env`, run `docker compose up -d`. `docker compose restart` does not read `.env` again.

### Required

The bot exits if one of these is missing.

| Setting             | Value                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `DISCORD_TOKEN`     | Bot token. If it's wrong, the log shows `login_failed`.                                                                |
| `GUILD_ID`          | The VATNZ server ID. The bot works only in this server, and leaves all others. For a test bot, use the test server ID. |
| `BOT_CONTACT_EMAIL` | Contact address sent to VATSIM, StatSim and vatnz.net with each request. Use an address that someone reads.            |
| `BOT_CONTACT_URL`   | Contact URL sent with each request, such as this repository or your own page.                                          |

### Needed for normal operation

| Setting                                 | Without it                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CHANNEL_ID`                            | No booking panel, so controllers can't book. Event threads and coverage posts also fail.                                                               |
| `LOG_CHANNEL_ID`                        | No audit posts and no event-thread prompts. `db/audit.jsonl` still records everything.                                                                 |
| `TRAINING_TEAM_ROLE_ID`                 | Nobody can be a mentor, so every booking that needs a mentor is deleted. Only members with this role can be tagged with `/mentor` and approve with 👍. |
| `BOT_OWNER_IDS`                         | Nobody can use `/maintenance` or `/statsim`. Owners can only be changed here.                                                                          |
| `BOARD_ROLE_ID`, `SENIOR_STAFF_ROLE_ID` | Users named in a permission list never get that permission.                                                                                            |
| `S1_ROLE_ID` … `I3_ROLE_ID`             | Controllers can't book the positions their rating allows. The highest rating applies: I3, I1, C3, C1, S3, S2, S1.                                      |
| `FSS_ROLE_ID`                           | Nobody can book FSS positions.                                                                                                                         |
| `EVENT_NOTIFICATIONS_ROLE_ID`           | Coverage posts ping nobody.                                                                                                                            |

### Access

Each staff permission has its own list.

| Permission          | Setting                      | Allows                                                   |
| ------------------- | ---------------------------- | -------------------------------------------------------- |
| `booking-moderator` | `BOOKING_MODERATOR_ROLE_IDS` | Edit or delete other controllers' bookings               |
| `event-position`    | `EVENT_POSITION_USER_IDS`    | Open and close event-only positions                      |
| `event-thread`      | `EVENT_THREAD_ROLE_IDS`      | Create or decline event threads from prompts             |
| `event-prompt`      | `EVENT_PROMPT_ROLE_IDS`      | Pinged by event-thread prompts                           |
| `mentor-approver`   | `MENTOR_APPROVER_USER_IDS`   | Approve a booking for a mentor, with **Approve booking** |

- A role in a list gives the permission to all members of that role.
- A user in a list has the permission only while they hold `BOARD_ROLE_ID` or `SENIOR_STAFF_ROLE_ID`. When they lose the role, the access lapses. At startup, the bot posts a warning for each named user who lost the role or left the server.
- Bot owners change lists with `/maintenance access add|remove`. A list can then hold roles and users. The first change saves that permission's list in `db/settings.json`. After that, the setting in `.env` has no effect on that permission. To use `.env` again, stop the bot, remove the permission from the `access` entry in `db/settings.json`, and start the bot.

### Booking limits

| Setting                         | Default | Effect                                                                                |
| ------------------------------- | ------- | ------------------------------------------------------------------------------------- |
| `MAX_ACTIVE_BOOKINGS`           | 3       | Normal bookings a controller can hold that haven't ended. Event bookings don't count. |
| `MAX_BOOKING_DAYS_AHEAD`        | 14      | How far ahead a normal booking can start.                                             |
| `MENTOR_REQUEST_COOLDOWN_HOURS` | 3       | Time between `/mentor` requests for one booking.                                      |
| `BOOKING_REMINDERS_ENABLED`     | true    | DM reminders before a booking.                                                        |
| `BOOKING_REMINDER_MINUTES`      | 30      | How long before the start the reminder is sent.                                       |

### Outside services

| Setting                                                                                          | Default         | Effect                                                                                          |
| ------------------------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------- |
| `EVENT_CALENDAR_URL`, `VATNZ_POSITIONS_URL`, `SOLO_ENDORSEMENTS_URL`, `S1_SOLO_ENDORSEMENTS_URL` | vatnz.net pages | Sources for events, positions and endorsements. Change them only if vatnz.net moves them.       |
| `STATSIM_ENABLED`                                                                                | true            | Starting state of StatSim lookups. `/statsim` changes override it.                              |
| `STATSIM_TIMEOUT_MS`                                                                             | 15000           | StatSim request timeout. Other requests time out after 10 s.                                    |
| `STATSIM_HEALTH_CHECK_MINUTES`                                                                   | 5               | Time between StatSim health checks. A failed StatSim is switched back on when a check succeeds. |
| `STATSIM_ZERO_FALLBACK_YEARS`                                                                    | 3               | Earlier years to try when a week has no traffic.                                                |

### Container limits

Optional. Compose reads them from `.env`.

| Setting            | Default          |
| ------------------ | ---------------- |
| `BOT_MEMORY_LIMIT` | `512m` (no swap) |
| `BOT_CPU_LIMIT`    | `1.0`            |
| `BOT_PIDS_LIMIT`   | `100`            |

## Deploy

1. Put `compose.yaml` and `.env` in one directory on the host.
2. Run `docker compose up -d` in that directory.
3. Check the log: `startup`, then `ready`. There must be no `config_missing`, `login_failed` or `left_guild`.
4. Check that the booking panel is in the booking channel.
5. In **Server Settings > Integrations**, allow `/maintenance` for the bot owners and **Approve booking** for the mentor approvers. Only these two commands are hidden by default. When you add owners or approvers later, allow the command for them too. The bot checks permissions itself, so a visible command gives no access.
6. Run `/maintenance access list` and check the lists.

`compose.yaml` pins the image to a major version (`:2`). A new major version can need changes to `.env`, so read the release notes before you change the pin.

## Container

`compose.yaml` runs the bot with these restrictions:

| Setting                                            | Effect                                                                                                 |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `read_only`, `tmpfs /tmp`                          | Only `/app/db` and a 16 MB `/tmp` are writable. App files are owned by root.                           |
| `cap_drop: ALL`, `no-new-privileges`               | No Linux capabilities. The process runs as `node` (UID 1000).                                          |
| `mem_limit`, `memswap_limit`, `cpus`, `pids_limit` | Limits from the [container settings](#container-limits). At the memory limit, Docker restarts the bot. |
| `logging`                                          | At most 5 × 10 MB of Docker logs.                                                                      |

Data is in the named volume `vatnz-booking-db`, mounted at `/app/db`. A bind mount also works if UID 1000 can write to it.

The `Dockerfile` pins the base image to an exact Node and Alpine release. Dependabot opens a pull request for each new release.

## Upgrade from v1 to v2

v2 changes how access works and adds required settings. Do these steps in this order:

1. Stop the old bot.
2. Back up the database volume and `.env`. The first start prunes some data, so a rollback needs this backup.
3. Compare `.env` with the new `.env.example`, and add the new settings. Set `GUILD_ID`, `BOT_CONTACT_EMAIL`, `BOT_CONTACT_URL` and `BOT_OWNER_IDS` before you continue.
4. Replace `STAFF_ROLE_IDS` with the new settings. It gives no access now, and the bot only logs `setting_unused`.

   | Old staff action                           | New setting                                                        |
   | ------------------------------------------ | ------------------------------------------------------------------ |
   | Edit or delete other controllers' bookings | `BOOKING_MODERATOR_ROLE_IDS`                                       |
   | Open and close event positions             | `EVENT_POSITION_USER_IDS` (users, who need Board or Senior Staff)  |
   | Event-thread prompt buttons                | `EVENT_THREAD_ROLE_IDS`                                            |
   | Pinged by event-thread prompts             | `EVENT_PROMPT_ROLE_IDS`                                            |
   | `/statsim`                                 | `BOT_OWNER_IDS`                                                    |
   | (new) Approve bookings for mentors         | `MENTOR_APPROVER_USER_IDS` (users, who need Board or Senior Staff) |

5. Set `TRAINING_TEAM_ROLE_ID`, `BOARD_ROLE_ID` and `SENIOR_STAFF_ROLE_ID`.
6. Replace `compose.yaml` with the new file, in the same directory. It uses the same volume, `vatnz-booking-db`. If you used a different volume or a bind mount, change the new file to match.
7. If your data is still in JSON files at the project root (installs before the `db/` folder), move them into the database volume.
8. Pull the image and run `docker compose up -d`.
9. Do steps 3 to 6 of [Deploy](#deploy).

On the first start:

- Commands are registered in `GUILD_ID` only. The old global commands are removed, and can show in Discord for a short time.
- Open event-position dates saved as `DD/MM` are read as their nearest date. Check them in the booking channel.
- Event records and endorsement warnings older than 30 days are removed. The log shows a group of `event_record_pruned` lines.

To roll back, stop the bot, restore the backup from step 2, and use the old `compose.yaml` (image `:1`).

## Logs and data

- The bot logs one JSON line per event to stdout. This includes every interaction, outside request, DM sent (`dm_sent`), message deleted (`message_deleted`) and failure. Secrets are never logged.
- `db/audit.jsonl` is the permanent audit trail. The bot writes each entry there before it posts to the log channel. A failed post is also recorded.
- After a crash, the bot records the error and exits. Docker then restarts it.
- Discord disconnects and reconnects are logged. The bot reconnects automatically.

Files in `/app/db`:

| File                            | Contents                                            |
| ------------------------------- | --------------------------------------------------- |
| `messages.json`                 | Bookings                                            |
| `event.json`, `eventclose.json` | Open event-position dates and their announcements   |
| `eventthreads.json`             | Event prompts, threads and coverage posts           |
| `endorsementwarnings.json`      | Expiry warnings already sent                        |
| `settings.json`                 | Booking panel, StatSim state and saved access lists |
| `audit.jsonl`                   | Audit trail (append-only)                           |

At startup and then daily, the bot removes event records and endorsement warnings 30 days after the event or endorsement ends.

## Troubleshooting

| Symptom                                        | Cause                                                                         | Action                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Container restarts; log shows `config_missing` | A required setting is empty                                                   | Set it in `.env`                                                            |
| `login_failed`                                 | Wrong token, or Message Content Intent is off                                 | Correct the token or the intent                                             |
| `left_guild` after the bot joins               | `GUILD_ID` is wrong or a placeholder                                          | Correct `GUILD_ID`, then invite the bot again                               |
| "You don't have permission to do that."        | Not in the permission's list                                                  | Check with `/maintenance access list`                                       |
| "Your access to this action has lapsed."       | A named user lost the Board or Senior Staff role                              | Give the role back, or change the list                                      |
| `/mentor` refuses every mentor                 | `TRAINING_TEAM_ROLE_ID` is wrong                                              | Correct it                                                                  |
| A `.env` change has no effect                  | The container was restarted, not recreated, or `/maintenance` saved that list | Run `docker compose up -d`; for access, see [Access](#access)               |
| No log-channel posts                           | `LOG_CHANNEL_ID` is wrong, or the bot can't post there                        | Check the channel and its permissions. `audit.jsonl` still has every entry. |
| "Endorsement Overrides Suspended"              | The vatnz.net endorsement pages failed for over 24 hours                      | Check the pages. The bot recovers when they load.                           |
| StatSim data unavailable                       | StatSim is down or switched off                                               | Check with `/statsim mode:status`                                           |
