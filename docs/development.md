# Development

This guide is for contributors. It assumes Node.js 22 and familiarity with discord.js v14.

## Local setup

1. Run `npm install`.
2. Create `.env` from `.env.example`. Use a test application and a test server for `GUILD_ID`.
3. Run `npm start`.

Run the tests with `npm test`. The tests use `node:test` and stubs, and need no Discord or network access.

## Project layout

| Path                               | Purpose                                                               |
| ---------------------------------- | --------------------------------------------------------------------- |
| `index.js`                         | Startup: required settings, wiring, command registration, shutdown    |
| `src/commands/definitions.js`      | Slash and message command definitions                                 |
| `src/constants.js`                 | Role IDs, timeouts, event positions and sectors, from the environment |
| `src/data/`                        | JSON database setup in `db/`                                          |
| `src/handlers/interactions.js`     | Commands, buttons, menus and modals                                   |
| `src/handlers/editBookings.js`     | `/editbookings` picker, form and save                                 |
| `src/handlers/ready.js`            | Ready-time setup, schedulers, booking panel, server lock              |
| `src/handlers/process.js`          | Unhandled errors, crashes, Discord connection logging                 |
| `src/services/access.js`           | Permission lists, owners, `/maintenance` changes                      |
| `src/services/auditLog.js`         | Audit trail: `audit.jsonl`, then the log channel                      |
| `src/services/bookingLifecycle.js` | Cleanup, reminders, mentor timers and approvals                       |
| `src/services/bookingQueue.js`     | Queue for all changes to bookings                                     |
| `src/services/eventPositions.js`   | Event-only position dates and automatic closing                       |
| `src/services/eventThreads.js`     | Calendar, event prompts, threads and coverage posts                   |
| `src/services/housekeeping.js`     | Daily pruning of old records                                          |
| `src/services/limits.js`           | Booking limits and mentor request cooldown                            |
| `src/services/positions.js`        | VATNZ positions, validation and eligibility                           |
| `src/services/soloEndorsements.js` | Endorsement lists, mentor overrides, expiry warnings                  |
| `src/services/traffic.js`          | StatSim lookups, health checks, fallbacks                             |
| `src/services/vatsim.js`           | VATSIM ID lookup                                                      |
| `src/utils/http.js`                | Client for all outside requests                                       |
| `src/utils/log.js`                 | JSON logging and the startup settings allowlist                       |
| `src/utils/` (others)              | Booking menus, conflicts, ratings, permissions, formatting, time      |
| `tests/`                           | Test suites                                                           |

## Rules for changes

- **Bookings:** change bookings only inside `runBookingMutation` (`bookingQueue.js`). Wrap entry points only, not shared helpers, or the queue waits on itself.
- **Menus:** identify a booking by its message ID, never by its position in a list. Use `bookingMenuRows` for pickers.
- **Outside requests:** use `http.get` from `src/utils/http.js`. It adds the contact User-Agent, the limits and the 429 handling.
- **Permissions:** check them with `access.can()` and refuse with `REFUSALS`. Add a new permission to `PERMISSIONS` in `access.js`.
- **Limits:** read booking limits only through `getLimits()`. A future `/maintenance` override goes there.
- **Logging:** use `log(level, event, fields)`. Don't use `console`. Record staff-visible actions with `sendAuditLog`. Wrap scheduled tasks in `logFailures`.
- **Settings:** add each new non-secret setting to `.env.example` and to `LOGGED_SETTINGS` in `log.js`. A test checks that they match. Document it in [deployment.md](deployment.md#settings).
- **Behaviour:** describe new or changed behaviour as Gherkin scenarios in the issue.

## Releases

Each push to `main` runs semantic-release. It uses the Conventional Commits in the push:

| Commit type                                                  | Release |
| ------------------------------------------------------------ | ------- |
| `fix:`                                                       | Patch   |
| `feat:`                                                      | Minor   |
| `BREAKING CHANGE:` footer                                    | Major   |
| Other types (`chore:`, `ci:`, `docs:`, `refactor:`, `test:`) | None    |

A release publishes the image to `ghcr.io/vatnz-dev/booking-bot` with the tags `vX.Y.Z`, `X.Y.Z`, `X.Y`, `X` and `latest`. A manual `vX.Y.Z` tag also publishes an image.

Use `BREAKING CHANGE:` when a release needs changes to `.env` or `compose.yaml`. Deployments pin the major version, so this stops them from getting the change automatically.

Pull requests run the tests. Dependabot opens weekly pull requests for GitHub Actions, the Docker base image and npm. Base-image and runtime-dependency updates use `fix(deps):`, so they make a patch release.

## Inactive code

The VATSIM ATC booking API helpers in `src/services/vatsim.js` and `src/handlers/interactions.js` are commented out and make no requests. Before you enable them:

- Configure the API authentication.
- Replace the `TBC` division and subdivision values.
- Connect automatic deletions as well as manual deletions.
