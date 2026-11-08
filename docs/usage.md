# Usage

This guide is for controllers and staff. All times are New Zealand time. Enter times as `HHMM`. Enter booking dates as `DD/MM`. A date that has passed this year means next year.

## Book a session

1. In the booking channel, select **Book Controlling Session**.
2. Enter the position, date, start and end.
3. For an extendable CTR position, select extra sectors when the bot asks. If you don't select within 3 minutes, the booking keeps no extra sectors.

The bot posts the booking and replies with expected traffic.

A booking must:

- Start in the future and end on the same NZ day.
- Last at least 30 minutes.
- Be allowed by your rating, or by a current solo or S1 endorsement.
- Not overlap your other bookings. Back-to-back bookings are allowed.
- Not use a position or sector that another booking covers at that time. This includes inherited and extra sectors.

### Limits

| Booking | Limit                                                                                        |
| ------- | -------------------------------------------------------------------------------------------- |
| Normal  | At most 3 active bookings, starting up to 14 days ahead.                                     |
| Event   | One per event, for the next event only. Event bookings don't count towards the normal limit. |

A booking that overlaps an event in the VATNZ calendar, even partly, is an event booking. The values shown are the defaults. The bot operator can change them.

## Commands

| Command                                    | Who                  | Does                                                                                       |
| ------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------ |
| `/viewbookings`                            | Everyone             | Shows your bookings.                                                                       |
| `/editbookings`                            | Everyone             | Edits one of your bookings.                                                                |
| `/editbookings controller:@user`           | Booking moderators   | Edits another controller's booking.                                                        |
| `/deletebookings`                          | Everyone             | Deletes one of your bookings.                                                              |
| `/deletebookings controller:@user`         | Booking moderators   | Deletes another controller's booking.                                                      |
| `/mentor mentor:@user`                     | Everyone             | Asks a mentor to approve one of your bookings.                                             |
| `/myendorsements`                          | Everyone             | Shows your VATNZ solo and S1 endorsements.                                                 |
| `/expectedtraffic position date start end` | Everyone             | Shows traffic for the same window in the previous week.                                    |
| **Approve booking** (message command)      | Mentor approvers     | Approves a booking for a mentor. Hidden until a server admin allows it for you.            |
| `/openeventposition position date`         | Event-position staff | Opens an event-only position for one date.                                                 |
| `/closeeventposition position [date]`      | Event-position staff | Closes one date, or all dates.                                                             |
| `/statsim mode [reason]`                   | Bot owners           | Shows, enables or disables StatSim lookups.                                                |
| `/maintenance access list\|add\|remove`    | Bot owners           | Shows or changes who holds each permission. Hidden until a server admin allows it for you. |

Menus with more than 25 bookings have **Previous** and **Next** buttons.

## Edit a booking

`/editbookings` opens a form with the current position, date, times and extra sectors. For extra sectors, enter codes (`OCR, BAY, OHA, KAI, NAK, STH`) or full callsigns. Leave the field blank to remove them.

An edit has the same checks as a new booking. It also:

- Posts a new booking message and deletes the old one.
- Resets the reminder.
- Resets the mentor tag, the approval and the 3-hour mentor request limit. If the booking needs a mentor, use `/mentor` again within 5 minutes.

An edit that keeps its date and times is never refused for being too far ahead.

## Mentoring

A booking needs a mentor if your rating doesn't cover the position and no endorsement applies.

1. Within 5 minutes of booking, run `/mentor` and tag a training team member.
2. The mentor gets a DM. Within 30 minutes of the tag, the mentor approves with 👍 on the booking. Only the tagged mentor's 👍 counts.

If either time runs out, the bot deletes the booking and tells you by DM.

- You can't tag yourself, a bot, or someone without the training team role.
- You can send one mentor request per booking every 3 hours.
- Mentor approvers can approve instead with **Approve booking**: right-click the booking post, then **Apps**. A reason is required. This works with or without a `/mentor` tag, before the booking is deleted. Approvers can't approve their own booking.

## Endorsements

The bot reads the VATNZ solo and S1 endorsement lists. A current endorsement removes the mentor requirement for its positions. The bot DMs you 30 days and 1 day before an endorsement expires, and on the day it expires.

If the lists can't be read for more than 24 hours, endorsements stop applying, and bookings need a mentor until the lists load again.

## Event-only positions

Event-position staff open a position for a date. To open more dates, run `/openeventposition` again for each date. Select the position from the command's list.

- `DD/MM` means this year. Use `DD/MM/YYYY` for another year.
- Impossible dates and past dates are refused.
- Each date gets its own announcement in the booking channel.

A booking for an event-only position must be on an open date, year included. Each date closes automatically after it has passed, and its announcement is deleted. `/closeeventposition` without a date closes all dates. Existing bookings stay.

## Event threads

The bot reads the VATNZ calendar every 5 minutes.

- Events in the next 7 days get a prompt in the log channel, which pings the event-prompt roles.
- Christchurch Control events get a thread automatically. For other events, event-thread staff select **Create thread** or **Decline**.
- Bookings that overlap the event move into its thread.
- 1 hour before the event, the bot posts a coverage summary in the booking channel. It updates when bookings change.
- The coverage summary is deleted when the event ends. The thread is deleted 1 hour after the event ends.

## Expected traffic

Traffic comes from StatSim, for the same weekday window in the previous week. If that week has no traffic, the bot tries the same weekday in earlier years.

When StatSim fails, lookups switch off and the bot checks StatSim again every few minutes. When StatSim recovers, lookups switch on again, unless a bot owner disabled them with `/statsim`.

## Audit

The bot records every booking, mentor, event, permission and system action. Staff see these records in the log channel. Refused actions are also recorded.
