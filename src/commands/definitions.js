const { FALLBACK_EVENT_POSITIONS } = require('../constants');

const eventPositionChoices = FALLBACK_EVENT_POSITIONS.map((value) => ({
  name: value.toLowerCase(),
  value
}));

module.exports = [
  {
    name: 'viewbookings',
    description: 'View your controller bookings.'
  },
  {
    name: 'myendorsements',
    description: 'View your VATNZ solo and S1 endorsements.'
  },
  {
    name: 'deletebookings',
    description: 'Delete your controller bookings.',
    options: [
      {
        type: 6,
        name: 'controller',
        description: 'Staff only: delete another controller booking.',
        required: false
      }
    ]
  },
  {
    name: 'expectedtraffic',
    description: 'Check expected traffic using previous-week StatSim data.',
    options: [
      {
        type: 3,
        name: 'position',
        description: 'Position, e.g. NZCH_APP',
        required: true
      },
      {
        type: 3,
        name: 'date',
        description: 'NZ date in DD/MM format',
        required: true
      },
      {
        type: 3,
        name: 'start',
        description: 'Start time in HHMM format',
        required: true
      },
      {
        type: 3,
        name: 'end',
        description: 'End time in HHMM format',
        required: true
      }
    ]
  },
  {
    name: 'openeventposition',
    description: 'Open event positions.',
    options: [
      {
        type: 3,
        name: 'position',
        description: 'What position do you want to open?',
        required: true,
        choices: eventPositionChoices
      },
      {
        type: 3,
        name: 'date',
        description: 'What date do you want to open? Format: DD/MM',
        required: true
      }
    ]
  },
  {
    name: 'closeeventposition',
    description: 'Close event positions.',
    options: [
      {
        type: 3,
        name: 'position',
        description: 'What position do you want to close?',
        required: true,
        choices: eventPositionChoices
      }
    ]
  },
  {
    name: 'mentor',
    description: 'Tag your mentor in your post',
    options: [
      {
        type: 6,
        name: 'mentor',
        description: 'Tag your mentor. Format: @mymentor',
        required: true
      }
    ]
  }
];
