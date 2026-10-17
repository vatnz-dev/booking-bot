# VATNZ ATC Booking Bot

VATNZ ATC Booking Bot is a Discord bot for controller booking, mentoring workflows, expected traffic checks, staff audit logging, and VATNZ event coordination.

## Features

- Book ATC sessions from Discord with controller rating and mentor checks.
- Require booking sessions to be at least 30 minutes long.
- DM booking reminders before sessions start.
- Explain booking conflicts with the conflicting controller and time window.
- View and delete bookings with `/viewbookings` and `/deletebookings`.
- Staff can use `/deletebookings controller:@user` to delete another controller's booking.
- Log booking creates, deletes, mentor actions, auto-deletes, event prompts, event thread creation, and event booking moves.
- Fetch VATNZ events from the official calendar feed and create event threads.
- Automatically create Christchurch Control event threads based on the event name, including the current VATNZ feed typo `Chrsitchurch Control`.
- Post event coverage notifications in the booking/events channel 1 hour before event start.
- Render booking and event times with Discord timestamps so users see local times.
- Delete event threads 1 hour after the event ends.
- Move overlapping bookings into event threads by reposting the booking embed, deleting the original, and updating stored message IDs.
- Check expected previous-week StatSim traffic with `/expectedtraffic`, including prior-year weekday fallback when StatSim has no movements for the requested window.
- Staff can disable or enable StatSim traffic lookups with `/statsim` when StatSim is down.
- Apply current VATNZ solo/S1 endorsements to remove mentor requirements for matching positions.
- Warn known booking users 30 days, 1 day, and on the day a dated endorsement expires.

## Requirements

- Node.js 20 or newer.
- npm, which is bundled with Node.js.
- A Discord bot token.
- A Discord server where the bot has permission to manage slash commands, send messages, add reactions, create public threads, and delete its own booking/thread messages.

## Environment Variables

Copy `.env.example` to `.env` in the project root, then fill in your real Discord values:

```env
DISCORD_TOKEN=your_bot_token_here
CHANNEL_ID=your_booking_channel_id_here
LOG_CHANNEL_ID=your_staff_log_channel_id_here
STAFF_ROLE_ID=your_staff_role_id_here
EVENT_NOTIFICATIONS_ROLE_ID=your_event_notifications_role_id_here
BOOKING_REMINDERS_ENABLED=true
BOOKING_REMINDER_MINUTES=30
EVENT_CALENDAR_URL=https://www.vatnz.net/events/calendar/vatnz-lite.ics
VATNZ_POSITIONS_URL=https://www.vatnz.net/airspace/positions/
SOLO_ENDORSEMENTS_URL=https://www.vatnz.net/controllers/endorsements/approved-solo-endorsements/
S1_SOLO_ENDORSEMENTS_URL=https://www.vatnz.net/controllers/endorsements/list-s1-holders-approved-connect-under-622-s1-tower-trainee-policy/
STATSIM_ENABLED=true
STATSIM_TIMEOUT_MS=15000
STATSIM_ZERO_FALLBACK_YEARS=3
```

Keep real Discord channel IDs, role IDs, and bot tokens only in your local `.env`. Never commit `.env` or paste real server IDs into this README.

## Project Layout

- `index.js` - Discord client setup and module wiring.
- `src/handlers/interactions.js` - Slash command, button, select menu, and modal handlers.
- `src/handlers/ready.js` - Discord ready-time presence, schedulers, and booking prompt setup.
- `src/commands/definitions.js` - Slash command definitions synced with Discord.
- `src/constants.js` - Shared role IDs, timeouts, event positions, and sector mappings.
- `src/data/databases.js` - Runtime JSON database setup.
- `src/services/auditLog.js` - Staff audit-log embed delivery.
- `src/services/bookingLifecycle.js` - Booking cleanup, mentor timers, and reaction approval handling.
- `src/services/discordHelpers.js` - Channel/message lookup helpers.
- `src/services/eventThreads.js` - VATNZ event feed parsing and event-thread lifecycle.
- `src/services/positions.js` - VATNZ position lookup, validation, and booking eligibility.
- `src/services/soloEndorsements.js` - VATNZ solo/S1 endorsement lookup, mentor overrides, and expiry warnings.
- `src/services/traffic.js` - Previous-week StatSim traffic lookup and prior-year fallback handling.
- `src/services/vatsim.js` - VATSIM Discord account lookup.
- `src/utils/format.js` - Shared formatting helpers.
- `src/utils/time.js` - NZ/UTC date and time helpers.

## Local Setup

Clone the repository, open a terminal in the project folder, then install dependencies:

```bash
npm install
```

Start the bot:

```bash
npm start
```

On Windows PowerShell, if `npm` is blocked by script execution policy, use:

```powershell
npm.cmd install
npm.cmd start
```

## Commands

- `/viewbookings` - View your current bookings.
- `/myendorsements` - View your VATNZ solo/S1 endorsements and expiry status.
- `/deletebookings` - Delete one of your bookings.
- `/deletebookings controller:@user` - Staff only; delete another controller's booking.
- `/mentor mentor:@user` - Tag a mentor for a booking.
- `/expectedtraffic position:NZCH_APP date:DD/MM start:HHMM end:HHMM` - Show expected previous-week traffic for the same NZ date/time window.
- `/statsim mode:status|enable|disable reason:optional` - Staff only; toggle StatSim traffic lookups.
- `/openeventposition` - Open an event-only position for a date.
- `/closeeventposition` - Close an event-only position.

Bookings shorter than 30 minutes are rejected.
Controllers cannot create overlapping bookings, even at different positions or in different event threads. Back-to-back bookings are allowed.
Booking reminders are sent by DM `BOOKING_REMINDER_MINUTES` minutes before start unless `BOOKING_REMINDERS_ENABLED=false`.
StatSim starts enabled unless `STATSIM_ENABLED=false` is set. Runtime changes from `/statsim` are stored in `settings.json` and override the env default until changed again.
Failed requests or unreadable StatSim traffic automatically disable lookups. The bot probes the traffic endpoint on startup and every `STATSIM_HEALTH_CHECK_MINUTES` (default 5), automatically re-enabling lookups after recovery. Valid zero counts are accepted as a healthy response. A staff `/statsim mode:disable` stays disabled until staff enable it again. During an outage, users see: "No StatSim data available at the moment due to server/bot errors."

## Event Threads

The booking panel is reused across restarts. Its message ID is saved in `settings.json`; existing panels are adopted automatically, and a new panel is posted only when none exists. The bot needs View Channel and Read Message History permissions to check for an existing panel.

The bot checks the VATNZ calendar feed on startup and every 5 minutes.

- Events inside the next 7 days get a staff prompt in the log channel.
- Christchurch Control events are created automatically by matching the VATNZ event name, not by checking NZCH positions.
- Other events show Create Thread and Decline buttons for staff.
- Event threads are public threads under the booking channel.
- Event embeds use Discord timestamps for start/end times, so controllers outside NZ see their local time.
- 1 hour before an event starts, the bot posts a coverage embed in the booking/events channel and pings `EVENT_NOTIFICATIONS_ROLE_ID` if configured.
- The coverage embed lists booked airport positions, enroute/control positions, extensions, and the event start timestamp.
- If bookings are created, deleted, auto-deleted, or extended after the coverage embed posts, the bot edits that existing embed.
- The coverage embed is deleted when the event finishes.
- Event thread names use the format `Christchurch Control - 13th May`.
- Existing overlapping bookings are reposted into the thread, original messages are deleted, and `messages.json` is updated.
- New overlapping bookings are posted directly into the event thread.
- Event threads are deleted automatically 1 hour after the event end time.

## Runtime Files

These files are created locally and ignored by git:

- `.env`
- `event.json`
- `eventclose.json`
- `endorsementwarnings.json`
- `messages.json`
- `eventthreads.json`
- `settings.json`
- `node_modules/`

The bot creates missing runtime JSON files automatically with empty objects. Demo versions live in `examples/`:

- `examples/event.demo.json`
- `examples/eventclose.demo.json`
- `examples/endorsementwarnings.demo.json`
- `examples/messages.demo.json`
- `examples/eventthreads.demo.json`
- `examples/settings.demo.json`

Solo endorsement expiry warnings are sent to Discord users the bot can map to a VATSIM CID, currently users with bookings stored in `messages.json`.

## Test Checklist

1. Run `node --check index.js` and check the files in `src/`.
2. Install dependencies with `npm install`.
3. Add a local `.env`.
4. Start with `npm start`.
5. In Discord, test:
   - Normal user creates, views, and deletes their own booking.
   - Normal user cannot delete another controller's booking.
   - Staff user deletes another controller's booking and the log channel receives an audit embed.
   - Mentor-required booking auto-deletes if no mentor is tagged or approval times out.
   - `/expectedtraffic NZCH_APP DD/MM HHMM HHMM` returns previous-week traffic.
   - Staff `/statsim mode:disable` makes expected traffic replies say StatSim data is unavailable, and `/statsim mode:enable` restores lookups.
   - Christchurch Control event auto-creates a thread.
   - Non-Christchurch event prompt buttons work.
   - Matching bookings move into the event thread and remain deletable after moving.
   - Event thread deletes automatically 1 hour after the event ends.
