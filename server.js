const express = require('express');
const fs = require('fs');
const moment = require('moment-timezone');
const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));

// Homepage route
app.get('/', (req, res) => {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync('./data/messages.json'));
  } catch (err) {
    console.error('❌ Could not read messages.json:', err);
    return res.status(500).send('Booking data not found.');
  }

  const bookings = [];

  for (const userId in raw) {
    const userBookings = raw[userId];
    if (Array.isArray(userBookings)) {
      for (const b of userBookings) {
        bookings.push({
          position: b.position,
          date: b.date,
          start: b.start,
          end: b.end,
          controller: userId,
          extendedSectors: b.extendedSectors || [],
          event: b.event || null
        });
      }
    }
  }

  // Sort by date and start time
  bookings.sort((a, b) => {
    if (a.date === b.date) {
      return parseInt(a.start) - parseInt(b.start);
    }
    return a.date.localeCompare(b.date);
  });

  res.render('home', { bookings });
});

// Start server
app.listen(3000, () => {
  console.log('✅ VATNZ Booking Site running at http://localhost:3000');
});
