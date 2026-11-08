const { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');

// Booking pickers page past Discord's 25 options with Previous/Next buttons whose IDs end in the page number.
// `value(booking)` runs only for the bookings on the page being shown.
function bookingMenuRows({ bookings, page, menuId, pageId, placeholder, value }) {
  const pages = Math.max(1, Math.ceil(bookings.length / 25));
  const current = Math.min(Math.max(0, page), pages - 1);
  const hhmm = time => String(time).padStart(4, '0');
  const options = bookings.slice(current * 25, current * 25 + 25).map(b => ({
    label: `${b.position} on ${b.date} at ${hhmm(b.start)}`.slice(0, 100),
    description: `Ends at ${hhmm(b.end)}`,
    value: value(b)
  }));
  const rows = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(menuId).setPlaceholder(placeholder).addOptions(options)
  )];
  if (pages > 1) {
    rows.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${pageId}:${current - 1}`).setLabel('Previous').setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
      new ButtonBuilder().setCustomId(`${pageId}:${current + 1}`).setLabel(`Next (page ${current + 1} of ${pages})`).setStyle(ButtonStyle.Secondary).setDisabled(current === pages - 1)
    ));
  }
  return rows;
}

module.exports = { bookingMenuRows };
