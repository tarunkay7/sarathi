require('dotenv').config();
const pool = require('./pool');

const services = [
  {
    key: 'renew',
    title: "Driving Licence Renewal",
    form_number: 'Form 9',
    fee_cents: 40000,
    requires_slot: true,
    slot_purpose: 'photo and biometric capture',
    carry_items: 'Acknowledgement slip and your existing driving licence',
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
    // Telangana's faceless services cover updates and duplicates for people who
    // already hold a licence, not first-time LL issuance, so the computerised
    // test is still taken in person here. States with faceless LL (Delhi,
    // Maharashtra, Karnataka and others) allow it from home over a webcam.
    requires_slot: true,
    slot_purpose: "the computerised learner's licence test",
    carry_items: 'Acknowledgement slip and your Aadhaar card',
    expected_days: 3,
    // Parivahan splits this into "upload photo and signature" plus "upload
    // documents". With Aadhaar eKYC the signature is the only genuine upload,
    // so both stages collapse into one confirmation. The old checklist also
    // listed the test booking slip, which this flow produces rather than asks
    // for.
    checklist: [
      { label: 'Proof of age and address', badge: 'Fetched from Aadhaar eKYC' },
      { label: 'Passport-size photograph', badge: 'Fetched from Aadhaar eKYC' },
      { label: 'Specimen signature', badge: 'One-time upload', upload: 'signature' },
      { label: 'Self-declaration of physical fitness (Form 1)', badge: 'Declared online' },
    ],
    eligibility: { minAge: 18, roadSafetyTutorial: true },
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
    // Replaces the change-of-address service. Parivahan lists 7 stages here
    // too, with the same two problems as the learner's licence: "verify the pay
    // status" is the system reconciling with the bank, and "print the receipt"
    // is an artifact — neither is a task the citizen should be handed. The two
    // upload stages are also one idea. Test slot booking already precedes
    // payment upstream, so that ordering carries over unchanged.
    key: 'dl',
    title: 'Permanent Driving Licence',
    form_number: 'Form 4',
    // Demo figure covering the driving test and licence issue. Real fees are
    // set per state — confirm against the Telangana schedule before quoting.
    fee_cents: 70000,
    requires_slot: true,
    slot_purpose: 'your driving skill test',
    carry_items: "Acknowledgement slip, your learner's licence, and the vehicle you will be tested on",
    // The dependency that trips people up: unlike every other service here,
    // this one cannot be started until a separate licence has been held for a
    // while, so it is stated before any details are confirmed.
    prerequisite_note: "You need a valid learner's licence for the same vehicle class, issued at least 30 days ago and not yet expired.",
    expected_days: 7,
    checklist: [
      { label: "Valid learner's licence", badge: 'On file' },
      { label: 'Proof of age and address', badge: 'Fetched from Aadhaar eKYC' },
      { label: 'Passport-size photograph', badge: 'Fetched from Aadhaar eKYC' },
      { label: 'Specimen signature', badge: 'One-time upload', upload: 'signature' },
      { label: 'Self-declaration of physical fitness (Form 1)', badge: 'Declared online' },
    ],
    eligibility: { form1aMinAge: 40, transportCategoryKeywords: ['Transport', 'HMV', 'HGV', 'HPMV', 'PSV'] },
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

// DEMO DATA — illustrative only. The pincodes are real Hyderabad-area
// pincodes grouped under plausible RTOs, but official jurisdiction boundaries
// come from Telangana Transport Department notifications and must be sourced
// from there before this is used for anything real. Unmapped pincodes fall
// back to letting the citizen pick their RTO, so a wrong guess is never
// silently applied.
const rtoPincodes = {
  Kukatpally: ['500072', '500085', '500018', '500037'],
  Khairatabad: ['500004', '500082', '500063', '500001'],
  Uppal: ['500039', '500098', '500092', '500076', '500013'],
  Medchal: ['501401', '500100'],
  Ibrahimpatnam: ['501510', '501505'],
};

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

  let pincodeCount = 0;
  for (const [rtoName, pincodes] of Object.entries(rtoPincodes)) {
    const found = await pool.query('SELECT id FROM rtos WHERE name = $1', [rtoName]);
    if (!found.rows[0]) continue;
    for (const pincode of pincodes) {
      await pool.query(
        `INSERT INTO rto_pincodes (pincode, rto_id) VALUES ($1,$2)
         ON CONFLICT (pincode) DO UPDATE SET rto_id = EXCLUDED.rto_id`,
        [pincode, found.rows[0].id]
      );
      pincodeCount += 1;
    }
  }
  console.log(`Seeded ${pincodeCount} RTO pincode mappings.`);

  for (const svc of services) {
    await pool.query(
      `INSERT INTO services (key, title, form_number, fee_cents, requires_slot, slot_purpose, carry_items, prerequisite_note, expected_days, checklist, eligibility)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (key) DO UPDATE SET
         title = EXCLUDED.title,
         form_number = EXCLUDED.form_number,
         fee_cents = EXCLUDED.fee_cents,
         requires_slot = EXCLUDED.requires_slot,
         slot_purpose = EXCLUDED.slot_purpose,
         carry_items = EXCLUDED.carry_items,
         prerequisite_note = EXCLUDED.prerequisite_note,
         expected_days = EXCLUDED.expected_days,
         checklist = EXCLUDED.checklist,
         eligibility = EXCLUDED.eligibility`,
      [
        svc.key,
        svc.title,
        svc.form_number,
        svc.fee_cents,
        svc.requires_slot,
        svc.slot_purpose || null,
        svc.carry_items || null,
        svc.prerequisite_note || null,
        svc.expected_days,
        JSON.stringify(svc.checklist),
        JSON.stringify(svc.eligibility),
      ]
    );
  }
  console.log(`Seeded ${services.length} services.`);

  // The demo persona applies for a permanent licence, so the challan has to
  // block that rather than a renewal. Attached by mobile number because ids
  // differ between the local and deployed databases.
  const demo = await pool.query(
    'SELECT id FROM citizens WHERE mobile_number = $1',
    ['9000000009']
  );
  if (demo.rows[0]) {
    // A seed's job is to restore the fixture, not just create it once. Paying
    // this challan during a demo or a verification run must not permanently
    // consume it — the next seed has to put it back to pending, not skip it.
    await pool.query(
      `INSERT INTO challans (challan_number, citizen_id, offence, location, issued_on, amount_cents, status)
       VALUES ($1,$2,$3,$4,$5,$6,'pending')
       ON CONFLICT (challan_number) DO UPDATE
         SET status = 'pending', paid_at = NULL`,
      ['CH-2026-8841', demo.rows[0].id, 'Signal violation', 'Uppal X Roads, Hyderabad', '2026-08-12', 100000]
    );
    console.log('Seeded 1 pending challan for the demo account.');
  }

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
