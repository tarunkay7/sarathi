const fs = require('fs');
const os = require('os');
const path = require('path');
const pool = require('../db/pool');

// Adobe renders a single HTML file, so every style has to be inline — a linked
// stylesheet would not be uploaded alongside it.
function esc(value) {
  return String(value == null ? '—' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(value) {
  if (!value) return '—';
  return new Date(value).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata',
  });
}

function formatDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  return `${formatDate(d)}, ${d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST`;
}

function maskMobile(mobile) {
  if (!mobile) return '—';
  return `+91 ${mobile.slice(0, 2)}XXXXX${mobile.slice(-3)}`;
}

function row(label, value) {
  return `<tr><th>${esc(label)}</th><td>${esc(value)}</td></tr>`;
}

// The stored enum should not surface on a document the citizen keeps.
const PAYMENT_STATUS = {
  pending: 'Pending',
  reconciling: 'Awaiting bank confirmation',
  paid: 'Paid in full',
  refund_in_progress: 'Refund in progress',
  failed: 'Failed',
};

function buildReceiptHtml(data) {
  const { application, citizen, payment, rto } = data;
  const fee = `₹${Math.round(application.fee_cents / 100)}`;
  const appointment = application.requires_slot
    ? `<h2>RTO appointment</h2>
       <table class="kv">
         ${row('Office', `RTO ${rto ? rto.name : citizen.rto}, ${citizen.state}`)}
         ${row('Purpose', application.slot_purpose || 'In-person visit')}
         ${row('Documents to carry', application.carry_items || 'Acknowledgement slip')}
       </table>`
    : '<p class="muted">No RTO visit is required for this service — it is processed entirely online.</p>';

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Receipt ${esc(application.reference_code)}</title>
<style>
  * { box-sizing: border-box; }
  /* Body owns the margin so the tricolour can bleed to the paper edge. Sized
     to keep the whole receipt on one A4 sheet — it spilled to two before. */
  @page { size: A4; margin: 0; }
  body { margin: 0; padding: 26px 34px; font-family: Helvetica, Arial, sans-serif; color: #202938; font-size: 10pt; line-height: 1.4; }
  .flag { height: 6px; display: flex; margin: -26px -34px 18px; }
  .flag i { flex: 1; }
  .flag i:nth-child(1) { background: #D98A2B; }
  .flag i:nth-child(2) { background: #F3EFE4; }
  .flag i:nth-child(3) { background: #2F7A4F; }
  /* States on the document itself what the footer already says, so the receipt
     cannot be mistaken for an official one if it is printed or forwarded. */
  .proto { background: #FBF0DF; border: 1px solid #D98A2B; color: #A3660F; font-size: 7.5pt;
           font-weight: bold; text-transform: uppercase; letter-spacing: .06em; text-align: center;
           padding: 4px 8px; border-radius: 4px; margin-bottom: 11px; }
  header { display: flex; justify-content: space-between; align-items: flex-start;
           border-bottom: 3px solid #22315C; padding-bottom: 13px; margin-bottom: 15px; }
  .kicker { text-transform: uppercase; letter-spacing: .12em; font-size: 7.5pt; font-weight: bold; color: #A3660F; }
  h1 { font-size: 16pt; margin: 4px 0 2px; color: #22315C; }
  header p { margin: 0; font-size: 8.5pt; color: #5B6473; }
  .mark { width: 42px; height: 42px; border-radius: 50%; background: #22315C; color: #fff;
          text-align: center; line-height: 42px; font-size: 18pt; font-weight: bold; }
  .ref { background: #EEF1F8; border-left: 4px solid #22315C; padding: 9px 14px; margin-bottom: 15px; }
  .ref .n { font-size: 14pt; font-weight: bold; color: #22315C; letter-spacing: .04em; }
  .ref .l { font-size: 7.5pt; text-transform: uppercase; letter-spacing: .06em; color: #5B6473; font-weight: bold; }
  h2 { font-size: 9.5pt; text-transform: uppercase; letter-spacing: .05em; color: #22315C;
       border-bottom: 1px solid #D9DEE8; padding-bottom: 4px; margin: 15px 0 6px; }
  table.kv { width: 100%; border-collapse: collapse; }
  table.kv th { text-align: left; font-weight: normal; color: #5B6473; width: 38%;
                padding: 4px 0; vertical-align: top; font-size: 9pt; }
  table.kv td { text-align: right; font-weight: bold; color: #202938; padding: 4px 0; vertical-align: top; font-size: 9pt; }
  .paid { display: flex; justify-content: space-between; align-items: center; margin-top: 10px;
          background: #EAF4EC; border: 1px solid #2F7A4F; border-radius: 6px; padding: 10px 14px; }
  .paid .amt { font-size: 15pt; font-weight: bold; color: #2F7A4F; }
  .paid .lbl { font-size: 8.5pt; font-weight: bold; color: #2F7A4F; text-transform: uppercase; letter-spacing: .06em; }
  .muted { color: #5B6473; font-size: 9pt; }
  footer { margin-top: 18px; border-top: 1px solid #D9DEE8; padding-top: 9px;
           font-size: 8pt; color: #667085; }
  footer strong { display: block; color: #202938; margin-bottom: 3px; }
</style></head>
<body>
  <div class="flag"><i></i><i></i><i></i></div>
  <div class="proto">Prototype — not an official government document · mock data only</div>
  <header>
    <div>
      <div class="kicker">Sarathi · concept redesign</div>
      <h1>Payment Receipt &amp; Acknowledgement</h1>
      <p>Independent prototype — not affiliated with or endorsed by MoRTH or NIC</p>
    </div>
    <div class="mark">S</div>
  </header>

  <div class="ref">
    <div class="l">Application number</div>
    <div class="n">${esc(application.reference_code)}</div>
  </div>

  <h2>Applicant</h2>
  <table class="kv">
    ${row('Name', citizen.name)}
    ${row('Date of birth', formatDate(citizen.dob))}
    ${row('Mobile', maskMobile(citizen.mobile_number))}
    ${row('Address on record', citizen.address)}
    ${row('Licence class', citizen.vehicle_classes)}
  </table>

  <h2>Service</h2>
  <table class="kv">
    ${row('Applied for', `${application.service_title} (${application.form_number})`)}
    ${row('Jurisdiction', `RTO ${rto ? rto.name : citizen.rto}, ${citizen.state}`)}
    ${row('Submitted on', formatDate(application.created_at))}
    ${row('Expected completion', formatDate(application.expected_by))}
  </table>

  <h2>Payment</h2>
  <table class="kv">
    ${row('Method', payment ? payment.method : '—')}
    ${row('Status', payment ? (PAYMENT_STATUS[payment.status] || payment.status) : 'Pending')}
    ${row('Paid on', payment ? formatDateTime(payment.confirmed_at || payment.created_at) : '—')}
  </table>
  <div class="paid"><span class="lbl">Total paid</span><span class="amt">${fee}</span></div>

  ${appointment}

  <footer>
    <strong>Keep this acknowledgement for your records and carry it to your appointment.</strong>
    This is a computer-generated receipt and does not require a signature.
    Generated ${formatDateTime(new Date())}. Prototype — not an official government document.
  </footer>
</body></html>`;
}

async function loadReceiptData(applicationId) {
  const appResult = await pool.query(
    `SELECT a.*, s.title AS service_title, s.fee_cents, s.requires_slot, s.form_number,
            s.slot_purpose, s.carry_items,
            r.name AS rto_name, r.city AS rto_city
     FROM applications a
     JOIN services s ON s.key = a.service_key
     JOIN citizens c ON c.id = a.citizen_id
     LEFT JOIN rtos r ON r.name = c.rto AND r.state = c.state
     WHERE a.id = $1`,
    [applicationId]
  );
  const application = appResult.rows[0];
  if (!application) return null;

  const citizenResult = await pool.query('SELECT * FROM citizens WHERE id = $1', [application.citizen_id]);
  const paymentResult = await pool.query(
    // The live payment is the one the receipt is for; a superseded duplicate
    // attempt must not be what the citizen sees. At most one row can be live.
    `SELECT * FROM payments WHERE application_id = $1
     ORDER BY (status IN ('reconciling','paid')) DESC, id DESC LIMIT 1`,
    [applicationId]
  );

  return {
    application,
    citizen: citizenResult.rows[0],
    payment: paymentResult.rows[0] || null,
    rto: application.rto_name ? { name: application.rto_name, city: application.rto_city } : null,
  };
}

function credentialsConfigured() {
  return Boolean(process.env.PDF_SERVICES_CLIENT_ID && process.env.PDF_SERVICES_CLIENT_SECRET);
}

// Adobe wants a readable stream over a real file, so the generated HTML is
// staged in the OS temp dir and removed once the job is submitted.
async function renderWithAdobe(html) {
  const {
    ServicePrincipalCredentials, PDFServices, MimeType,
    PageLayout, HTMLToPDFParams, HTMLToPDFJob, HTMLToPDFResult,
  } = require('@adobe/pdfservices-node-sdk');

  const tmpFile = path.join(os.tmpdir(), `sarathi-receipt-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  fs.writeFileSync(tmpFile, html, 'utf8');

  try {
    const pdfServices = new PDFServices({
      credentials: new ServicePrincipalCredentials({
        clientId: process.env.PDF_SERVICES_CLIENT_ID,
        clientSecret: process.env.PDF_SERVICES_CLIENT_SECRET,
      }),
    });

    const inputAsset = await pdfServices.upload({
      readStream: fs.createReadStream(tmpFile),
      mimeType: MimeType.HTML,
    });

    const job = new HTMLToPDFJob({
      inputAsset,
      params: new HTMLToPDFParams({
        // A4. includeHeaderFooter would add Adobe's own furniture on top of the
        // header this template already draws.
        pageLayout: new PageLayout({ pageWidth: 8.27, pageHeight: 11.69 }),
        includeHeaderFooter: false,
      }),
    });

    const pollingURL = await pdfServices.submit({ job });
    const result = await pdfServices.getJobResult({ pollingURL, resultType: HTMLToPDFResult });
    const streamAsset = await pdfServices.getContent({ asset: result.result.asset });
    return streamAsset.readStream;
  } finally {
    fs.promises.unlink(tmpFile).catch(() => {});
  }
}

module.exports = { buildReceiptHtml, loadReceiptData, credentialsConfigured, renderWithAdobe };
