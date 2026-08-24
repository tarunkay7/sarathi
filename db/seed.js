require('dotenv').config();
const pool = require('./pool');

const services = [
  {
    key: 'renew',
    title: "Driving Licence Renewal",
    form_number: 'Form 9',
    fee_cents: 40000,
    requires_slot: true,
    expected_days: 4,
    checklist: [
      { label: 'Self-declaration of physical fitness (Form 1)' },
      { label: 'Passport-size photograph', badge: 'Fetched from DigiLocker' },
      { label: 'Existing driving licence', badge: 'On file' },
    ],
    eligibility: { form1aMinAge: 40, transportCategoryKeywords: ['Transport', 'HMV', 'HGV', 'HPMV', 'PSV'] },
  },
  {
    key: 'new',
    title: "New Learner's Licence",
    form_number: 'Form 2',
    fee_cents: 20000,
    requires_slot: true,
    expected_days: 3,
    checklist: [
      { label: 'Self-declaration of physical fitness (Form 1)' },
      { label: 'Proof of age and address', badge: 'Fetched from DigiLocker' },
      { label: "Learner's test booking slip" },
    ],
    eligibility: { minAge: 18 },
  },
  {
    key: 'duplicate',
    title: 'Duplicate Licence',
    form_number: 'Form LLD',
    fee_cents: 30000,
    requires_slot: false,
    expected_days: 5,
    checklist: [
      { label: 'Police report or lost-licence affidavit' },
      { label: 'Passport-size photograph', badge: 'Fetched from DigiLocker' },
      { label: 'Self-declaration of physical fitness (Form 1)' },
    ],
    eligibility: {},
  },
  {
    key: 'address',
    title: 'Change of Address',
    form_number: 'Form 33',
    fee_cents: 20000,
    requires_slot: false,
    expected_days: 3,
    checklist: [
      { label: 'Proof of new address' },
      { label: 'Existing driving licence', badge: 'On file' },
    ],
    eligibility: {},
  },
];

// Telangana RTO offices. map_query is a Google Maps search string (not a
// verified postal address) so the embedded pin resolves to the real office
// without hard-coding coordinates we have not confirmed.
const rtos = [
  { name: 'Kukatpally', state: 'Telangana', city: 'Hyderabad', map_query: 'RTA Office Kukatpally, Hyderabad, Telangana', hours: 'Mon–Sat, 10:30 AM – 5:00 PM' },
  { name: 'Khairatabad', state: 'Telangana', city: 'Hyderabad', map_query: 'RTA Office Khairatabad, Hyderabad, Telangana', hours: 'Mon–Sat, 10:30 AM – 5:00 PM' },
  { name: 'Uppal', state: 'Telangana', city: 'Hyderabad', map_query: 'RTA Office Uppal, Hyderabad, Telangana', hours: 'Mon–Sat, 10:30 AM – 5:00 PM' },
  { name: 'Medchal', state: 'Telangana', city: 'Medchal', map_query: 'RTA Office Medchal, Telangana', hours: 'Mon–Sat, 10:30 AM – 5:00 PM' },
  { name: 'Ibrahimpatnam', state: 'Telangana', city: 'Ibrahimpatnam', map_query: 'RTA Office Ibrahimpatnam, Ranga Reddy, Telangana', hours: 'Mon–Sat, 10:30 AM – 5:00 PM' },
];

async function main() {
  for (const rto of rtos) {
    await pool.query(
      `INSERT INTO rtos (name, state, city, map_query, address, hours)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (name, state) DO UPDATE SET
         city = EXCLUDED.city,
         map_query = EXCLUDED.map_query,
         address = EXCLUDED.address,
         hours = EXCLUDED.hours`,
      [rto.name, rto.state, rto.city, rto.map_query, rto.address || null, rto.hours || null]
    );
  }
  console.log(`Seeded ${rtos.length} RTOs.`);

  for (const svc of services) {
    await pool.query(
      `INSERT INTO services (key, title, form_number, fee_cents, requires_slot, expected_days, checklist, eligibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key) DO UPDATE SET
         title = EXCLUDED.title,
         form_number = EXCLUDED.form_number,
         fee_cents = EXCLUDED.fee_cents,
         requires_slot = EXCLUDED.requires_slot,
         expected_days = EXCLUDED.expected_days,
         checklist = EXCLUDED.checklist,
         eligibility = EXCLUDED.eligibility`,
      [
        svc.key,
        svc.title,
        svc.form_number,
        svc.fee_cents,
        svc.requires_slot,
        svc.expected_days,
        JSON.stringify(svc.checklist),
        JSON.stringify(svc.eligibility),
      ]
    );
  }
  console.log(`Seeded ${services.length} services.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
