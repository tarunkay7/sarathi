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

async function main() {
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
