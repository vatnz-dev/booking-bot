# VATNZ ATC Booking Bot

A Discord bot for VATNZ ATC bookings, mentoring, event coordination, expected-traffic checks and a staff audit trail. It runs in one Discord server and is deployed as a Docker container.

_Last reviewed: 8 Nov 2026._

## Features

- Controllers book, view, edit and delete ATC sessions from Discord.
- Bookings are checked against rating, endorsements, sector coverage and booking limits.
- Trainee bookings need a mentor's approval, or training staff approval with a reason.
- VATNZ solo and S1 endorsements remove the mentor requirement for the endorsed positions.
- Event-only positions open for set dates and close automatically.
- Events from the VATNZ calendar get threads, coverage posts and booking moves.
- Expected traffic for a booking comes from StatSim.
- Each staff permission has its own list of roles or users, managed with `/maintenance`.
- Every action is logged as JSON and recorded in a local audit trail.

## Documentation

| Guide | For | Contents |
|---|---|---|
| [Deployment](docs/deployment.md) | Whoever runs the bot | Discord setup, settings, Docker, upgrades, troubleshooting, logs |
| [Usage](docs/usage.md) | Staff and controllers | Commands, booking rules, mentoring, events |
| [Development](docs/development.md) | Contributors | Project layout, local setup, tests, releases |

## Quick start

1. Set up the Discord application and invite the bot. See [Deployment: Discord setup](docs/deployment.md#discord-setup).
2. Copy `compose.yaml` and `.env.example` to the server. Rename `.env.example` to `.env` and fill it in.
3. Run `docker compose up -d`.
4. Do the checks and the Integrations step in [Deployment: Deploy](docs/deployment.md#deploy).

## Support

Maintained for VATNZ. Report problems in [GitHub issues](https://github.com/vatnz-dev/booking-bot/issues).
