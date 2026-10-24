const { FALLBACK_EVENT_POSITIONS } = require('../constants');
const { PERMISSIONS } = require('../services/access');

const accessOptions = [
  {
    type: 3,
    name: 'permission',
    description: 'Which permission to change.',
    required: true,
    choices: Object.entries(PERMISSIONS).map(([value, { label }]) => ({ name: `${value}: ${label}`.slice(0, 100), value }))
  },
  { type: 9, name: 'target', description: 'The role or user.', required: true }
];

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
    name: 'editbookings',
    description: 'Edit a booking, including its position, date, times and extra sectors.',
    options: [{
      type: 6,
      name: 'controller',
      description: 'Staff only: edit another controller booking.',
      required: false
    }]
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
    name: 'statsim',
    description: 'Staff: enable, disable, or check StatSim traffic lookups.',
    options: [
      {
        type: 3,
        name: 'mode',
        description: 'What to do with StatSim lookups.',
        required: true,
        choices: [
          { name: 'status', value: 'status' },
          { name: 'enable', value: 'enable' },
          { name: 'disable', value: 'disable' }
        ]
      },
      {
        type: 3,
        name: 'reason',
        description: 'Optional staff note for why StatSim is being changed.',
        required: false
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
    // Message context menu (right-click a booking post > Apps); hidden until allowed in Server Settings > Integrations.
    name: 'Approve booking',
    type: 3,
    default_member_permissions: '0'
  },
  {
    name: 'maintenance',
    description: 'Bot owners: manage who can use staff features.',
    default_member_permissions: '0',
    options: [{
      type: 2,
      name: 'access',
      description: 'Manage who has each permission.',
      options: [
        { type: 1, name: 'add', description: 'Give a role or user a permission.', options: accessOptions },
        { type: 1, name: 'remove', description: 'Take a permission away from a role or user.', options: accessOptions },
        { type: 1, name: 'list', description: 'Show who has each permission.' }
      ]
    }]
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
