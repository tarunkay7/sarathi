var session = { citizen: null, service: null, applicationId: null, referenceCode: null, application: null, pendingService: null };

async function api(path, opts){
  opts = opts || {};
  var res = await fetch(path, {
    method: opts.method || 'GET',
    headers: opts.body ? {'Content-Type':'application/json'} : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  var data = {};
  try { data = await res.json(); } catch(e) {}
  if(!res.ok) throw new Error(data.error || 'Something went wrong. Please try again.');
  return data;
}

function showScreen(id){
  document.querySelectorAll('.screen').forEach(function(s){ s.classList.remove('active'); });
  document.getElementById(id).classList.add('active');
  window.scrollTo(0,0);
}

function formatDate(d){
  return new Date(d).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'Asia/Kolkata' });
}

function formatDateTime(d){
  var dt = new Date(d);
  var datePart = dt.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric', timeZone:'Asia/Kolkata' });
  var timePart = dt.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' });
  return datePart + ', ' + timePart + ' IST';
}

function rupees(cents){ return '₹' + Math.round(cents / 100); }

function delay(ms){ return new Promise(function(resolve){ setTimeout(resolve, ms); }); }

async function syncAndShowDashboard(){
  showScreen('screen-syncing');
  // Long enough to register that a sync happened, short enough not to be a wait.
  await Promise.all([openDashboard(), delay(500)]);
  showScreen('screen-dashboard');
}

function initDocCardTilt(){
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if(reduceMotion) return;
  document.querySelectorAll('.doc-card').forEach(function(card){
    card.addEventListener('mousemove', function(e){
      var rect = card.getBoundingClientRect();
      var x = (e.clientX - rect.left) / rect.width;
      var y = (e.clientY - rect.top) / rect.height;
      var rotateY = (x - 0.5) * 10;
      var rotateX = (0.5 - y) * -10;
      card.style.transform = 'perspective(700px) rotateX(' + rotateX + 'deg) rotateY(' + rotateY + 'deg)';
    });
    card.addEventListener('mouseleave', function(){
      card.style.transform = '';
    });
  });
}

function humanSize(bytes){
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

// Sent as a raw body rather than multipart — the api() helper JSON-encodes, so
// this posts the File directly with its own content type.
async function uploadDocument(kind, file){
  var res = await fetch('/api/documents?applicationId=' + encodeURIComponent(session.applicationId) + '&kind=' + encodeURIComponent(kind), {
    method: 'POST',
    headers: { 'Content-Type': file.type || 'application/octet-stream' },
    body: file
  });
  var data = {};
  try { data = await res.json(); } catch(e) {}
  if(!res.ok) throw new Error(data.error || 'Upload failed. Please try again.');
  return data.document;
}

// Single source of truth for what this service actually needs uploaded.
function requiredUploads(service, citizen){
  var out = (service.checklist || []).filter(function(item){ return item.upload; }).map(function(item){
    return { kind: item.upload, label: item.label, accept: 'image/png,image/jpeg' };
  });
  if(computeForm1a(service, citizen).required){
    out.push({ kind: 'form_1a', label: 'Medical certificate (Form 1A)', accept: 'image/png,image/jpeg,application/pdf' });
  }
  return out;
}

function missingUploads(){
  if(!session.service || !session.citizen) return [];
  var done = session.uploads || {};
  return requiredUploads(session.service, session.citizen).filter(function(u){ return !done[u.kind]; });
}

var UPLOAD_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/></svg>';

function acceptLabel(accept){
  return accept.split(',')
    .map(function(m){ return m.split('/')[1].replace('jpeg', 'JPG').toUpperCase(); })
    .join(' · ');
}

function buildUploadRow(kind, accept, onDone){
  var box = document.createElement('div');
  box.className = 'uploader';

  var input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  input.className = 'uploader-input';
  input.id = 'up-' + kind + '-' + Math.random().toString(36).slice(2, 7);

  var label = document.createElement('label');
  label.className = 'uploader-drop';
  label.htmlFor = input.id;
  label.innerHTML =
    '<span class="uploader-ico">' + UPLOAD_ICON + '</span>' +
    '<span class="uploader-copy"><strong>Choose a file</strong> or drag it here' +
    '<span class="uploader-hint">' + acceptLabel(accept) + ' · up to 4 MB</span></span>';

  var done = document.createElement('div');
  done.className = 'uploader-done';

  var err = document.createElement('p');
  err.className = 'uploader-error';
  err.hidden = true;

  function showDone(doc, previewUrl){
    var isImage = doc.mime_type.indexOf('image/') === 0;
    done.innerHTML =
      (isImage && previewUrl
        ? '<img class="uploader-thumb" alt="" src="' + previewUrl + '">'
        : '<span class="uploader-thumb as-file">' + doc.mime_type.split('/')[1].toUpperCase() + '</span>') +
      '<span class="uploader-meta"><span class="uploader-name">' + doc.filename + '</span>' +
      '<span class="uploader-sub">' + humanSize(doc.size_bytes) + ' · uploaded</span></span>' +
      '<span class="uploader-actions">' +
        '<a class="uploader-link" href="/api/documents/' + doc.id + '/download">Download</a>' +
        '<button type="button" class="uploader-link danger" data-remove>Replace</button>' +
      '</span>';
    done.querySelector('[data-remove]').addEventListener('click', function(){
      // Clearing local state is enough: re-uploading overwrites the row, so a
      // failed delete would not orphan anything.
      fetch('/api/documents/' + doc.id, { method: 'DELETE' }).catch(function(){});
      if(session.uploads) delete session.uploads[kind];
      if(previewUrl) URL.revokeObjectURL(previewUrl);
      input.value = '';
      box.classList.remove('is-done');
      done.innerHTML = '';
    });
    box.classList.add('is-done');
  }

  var already = (session.uploads || {})[kind];
  if(already) showDone(already, null);

  async function handleFile(file){
    if(!file) return;
    err.hidden = true;
    box.classList.remove('is-error');
    box.classList.add('is-busy');
    label.querySelector('.uploader-copy').innerHTML = '<strong>Uploading…</strong><span class="uploader-hint">' + file.name + '</span>';
    try{
      var doc = await uploadDocument(kind, file);
      session.uploads = session.uploads || {};
      session.uploads[kind] = doc;
      showDone(doc, file.type.indexOf('image/') === 0 ? URL.createObjectURL(file) : null);
      if(onDone) onDone(doc);
    } catch(e){
      box.classList.add('is-error');
      err.textContent = e.message;
      err.hidden = false;
      input.value = '';
    } finally {
      box.classList.remove('is-busy');
      label.querySelector('.uploader-copy').innerHTML =
        '<strong>Choose a file</strong> or drag it here<span class="uploader-hint">' + acceptLabel(accept) + ' · up to 4 MB</span>';
    }
  }

  input.addEventListener('change', function(){ handleFile(input.files && input.files[0]); });

  ['dragenter', 'dragover'].forEach(function(evt){
    label.addEventListener(evt, function(e){ e.preventDefault(); box.classList.add('is-over'); });
  });
  ['dragleave', 'drop'].forEach(function(evt){
    label.addEventListener(evt, function(e){ e.preventDefault(); box.classList.remove('is-over'); });
  });
  label.addEventListener('drop', function(e){
    handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });

  box.appendChild(input);
  box.appendChild(label);
  box.appendChild(done);
  box.appendChild(err);
  return box;
}

function computeForm1a(service, citizen){
  var eligibility = (service && service.eligibility) || {};
  var minAge = eligibility.form1aMinAge;
  var keywords = eligibility.transportCategoryKeywords || [];
  // Classes being applied for take precedence over classes already held: on a
  // new licence the account holds none, and it is the class you are asking for
  // that decides whether a medical certificate is needed.
  var vehicleClasses = session.applyingClasses || (citizen && citizen.vehicle_classes) || '';
  var isTransportCategory = keywords.some(function(word){ return vehicleClasses.indexOf(word) !== -1; });

  if(isTransportCategory){
    return { required: true, reason: 'required, this licence covers a Transport Category vehicle' };
  }
  var dob = citizen && citizen.dob;
  if(!dob || !minAge) return { required: false, reason: '' };
  var birth = new Date(dob);
  var age = Math.floor((Date.now() - birth.getTime()) / (365.25*24*3600*1000));
  return { required: age >= minAge, reason: 'required, applicant is ' + minAge + ' or above' };
}

function updateEligibility(){
  var form1a = document.getElementById('form1a-line');
  if(!form1a) return;
  var result = computeForm1a(session.service, session.citizen);
  document.getElementById('form1a-reason').textContent = result.reason || 'required';
  form1a.hidden = !result.required;
}

var intakeSubstep = 1;

function renderIntakeSubsteps(){
  document.querySelectorAll('.intake-panel').forEach(function(p){ p.classList.remove('active'); });
  document.getElementById('intake-panel-' + intakeSubstep).classList.add('active');
  document.querySelectorAll('#intake-substeps .substep').forEach(function(s){
    var n = Number(s.getAttribute('data-substep'));
    s.classList.toggle('done', n < intakeSubstep);
    s.classList.toggle('active', n === intakeSubstep);
  });
  window.scrollTo(0, 0);
}

function renderIntakeScreen(){
  var service = session.service;
  document.getElementById('intake-title').textContent = service.title;
  document.getElementById('intake-applicant').textContent = session.citizen.name;
  document.getElementById('intake-state-rto').textContent = session.citizen.state + ' · ' + session.citizen.rto;
  document.getElementById('intake-dl-number').textContent = session.citizen.dl_number || '—';
  document.getElementById('intake-dob').textContent = session.citizen.dob ? formatDate(session.citizen.dob) : '—';
  // On a new licence this is the answer to a question further down the panel,
  // not a fact about the account — so say so rather than printing a dash.
  document.getElementById('intake-vehicle-class').textContent =
    session.applyingClasses
    || session.citizen.vehicle_classes
    || (serviceNeedsLearnerLicence(session.intakeServiceKey) ? 'You choose below' : 'None on record');

  // Read the stored flag rather than asserting "Verified" for everyone. Accounts
  // created through signup have not been through eKYC, and claiming otherwise on
  // the screen where the citizen confirms their details is a claim we cannot back.
  var needsLl = serviceNeedsLearnerLicence(session.intakeServiceKey);
  var llField = document.getElementById('intake-ll-field');
  var llInput = document.getElementById('intake-ll-input');
  llField.hidden = !needsLl;
  document.getElementById('intake-class-field').hidden = !needsLl;
  if(needsLl && !session.applicationId){
    llInput.value = '';
    llInput.readOnly = false;
    document.getElementById('intake-ll-error').hidden = true;
    document.getElementById('intake-class-error').hidden = true;
    document.querySelectorAll('[data-class-option]').forEach(function(box){
      box.checked = false;
      box.disabled = false;
    });
  }

  var kycVerified = session.citizen.aadhaar_kyc_verified;
  document.getElementById('intake-kyc').textContent = kycVerified ? 'Verified' : 'Not verified';
  document.getElementById('intake-source-note').textContent = kycVerified
    ? 'Fetched automatically from DigiLocker & Aadhaar — nothing to type here.'
    : 'Taken from the details you gave at signup. In a live service this step would run Aadhaar eKYC.';

  var list = document.getElementById('intake-checklist');
  list.innerHTML = '';
  service.checklist.forEach(function(item){
    var li = document.createElement('li');
    li.innerHTML = '<span class="tick">✓</span> ' + item.label + (item.badge ? ' <span class="doc-badge">' + item.badge + '</span>' : '');
    if(item.upload){
      li.appendChild(buildUploadRow(item.upload, 'image/png,image/jpeg'));
    }
    list.appendChild(li);
  });
  var form1a = document.createElement('li');
  form1a.className = 'extra';
  form1a.id = 'form1a-line';
  form1a.hidden = true;
  form1a.innerHTML = '<span class="tick">✓</span><span>Medical certificate (Form 1A) — <strong id="form1a-reason">required</strong></span><a class="form-link" href="/forms/FORM-1A.pdf" target="_blank" rel="noopener">Open Form 1A</a>';
  // The blank form was downloadable but there was nowhere to return the
  // completed one, so this was a dead end before.
  form1a.appendChild(buildUploadRow('form_1a', 'image/png,image/jpeg,application/pdf'));
  list.appendChild(form1a);

  document.getElementById('intake-fee-label').textContent = service.title + ' (' + service.form_number + ')';
  document.getElementById('intake-fee-amount').textContent = rupees(service.fee_cents);
  document.getElementById('intake-slot-section').hidden = !service.requires_slot;
  document.getElementById('intake-no-slot').hidden = !!service.requires_slot;
  document.getElementById('intake-fee-note').textContent =
    'Fixed by RTO ' + session.citizen.rto + '. No charges are added later in the process.';
  if(service.requires_slot){
    document.getElementById('intake-slot-note').textContent =
      'Pick an available date for your RTO visit' + (service.slot_purpose ? ' (' + service.slot_purpose + ')' : '') + '.';
  }

  var prereq = document.getElementById('intake-prerequisite');
  if(service.prerequisite_note){
    prereq.innerHTML = '<strong>Before you start:</strong> ' + service.prerequisite_note;
    prereq.hidden = false;
  } else {
    prereq.hidden = true;
  }

  // Show why this RTO was chosen — jurisdiction follows the eKYC address, so
  // the citizen can see it was not guessed from where they happen to be.
  var basis = document.getElementById('intake-rto-basis');
  if(session.citizen.pincode && session.citizen.rto){
    basis.innerHTML = 'Your application goes to <strong>RTO ' + session.citizen.rto + '</strong> — the office with jurisdiction over your Aadhaar address (pincode ' + session.citizen.pincode + '). This is set by where you ordinarily reside, not your current location.';
    basis.hidden = false;
  } else {
    basis.hidden = true;
  }

  var ack = document.getElementById('intake-road-safety');
  var ackBox = document.getElementById('road-safety-check');
  var needsAck = !!(service.eligibility && service.eligibility.roadSafetyTutorial);
  ack.hidden = !needsAck;
  ack.classList.remove('ack-missing');
  ackBox.checked = false;
  ackBox.onchange = function(){ if(ackBox.checked) ack.classList.remove('ack-missing'); };

  session.selectedSlot = null;
  document.getElementById('cal-times').hidden = true;
  document.getElementById('cal-slot-summary').textContent = '';
  if(service.requires_slot) renderCalendar();

  updateEligibility();
  intakeSubstep = 1;
  renderIntakeSubsteps();
}

var CAL_YEAR = 2026, CAL_MONTH = 8;
var CAL_AVAILABLE_DAYS = [2, 3, 4, 8, 9];
var CAL_TIMES = ['10:00–11:00 AM', '12:00–1:00 PM', '3:00–4:00 PM'];
var CAL_MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

function renderCalendar(){
  document.getElementById('cal-month-label').textContent = CAL_MONTH_NAMES[CAL_MONTH] + ' ' + CAL_YEAR;
  var grid = document.getElementById('cal-grid');
  grid.innerHTML = '';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(function(d){
    var el = document.createElement('div');
    el.className = 'cal-dow';
    el.textContent = d;
    grid.appendChild(el);
  });
  var firstDay = new Date(CAL_YEAR, CAL_MONTH, 1).getDay();
  var leadBlanks = (firstDay + 6) % 7;
  var daysInMonth = new Date(CAL_YEAR, CAL_MONTH + 1, 0).getDate();
  for(var i = 0; i < leadBlanks; i++){
    var blank = document.createElement('div');
    blank.className = 'cal-day empty';
    grid.appendChild(blank);
  }
  for(var day = 1; day <= daysInMonth; day++){
    var cell = document.createElement('div');
    cell.textContent = day;
    if(CAL_AVAILABLE_DAYS.indexOf(day) !== -1){
      cell.className = 'cal-day available';
      cell.addEventListener('click', function(d, el){ return function(){ selectCalendarDay(d, el); }; }(day, cell));
    } else {
      cell.className = 'cal-day';
    }
    grid.appendChild(cell);
  }
}

function selectCalendarDay(day, cell){
  document.querySelectorAll('.cal-day.available').forEach(function(el){ el.classList.remove('selected'); });
  cell.classList.add('selected');
  var dateLabel = formatDate(new Date(CAL_YEAR, CAL_MONTH, day).toISOString());
  document.getElementById('cal-selected-date').textContent = dateLabel;
  document.getElementById('cal-times').hidden = false;
  var chips = document.getElementById('cal-time-chips');
  chips.innerHTML = '';
  CAL_TIMES.forEach(function(time){
    var chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'time-chip';
    chip.textContent = time;
    chip.addEventListener('click', function(){
      chips.querySelectorAll('.time-chip').forEach(function(c){ c.setAttribute('aria-pressed', 'false'); });
      chip.setAttribute('aria-pressed', 'true');
      session.selectedSlot = { day: day, date: dateLabel, time: time };
      document.getElementById('cal-slot-summary').textContent = 'Selected: ' + dateLabel + ' · ' + time + ' · RTO ' + session.citizen.rto;
    });
    chips.appendChild(chip);
  });
}

function getAvailableSlotDates(){
  return CAL_AVAILABLE_DAYS.map(function(day){ return formatDate(new Date(CAL_YEAR, CAL_MONTH, day).toISOString()); });
}

async function createApplication(serviceKey, learnerLicenceNumber, vehicleClasses){
  // The POST resolves the service itself, so it does not wait on the GET. Run
  // both at once rather than paying two round trips back to back.
  var both = await Promise.all([
    api('/api/applications/service/' + serviceKey),
    api('/api/applications', { method:'POST', body:{
      citizenId: session.citizen.id,
      serviceKey: serviceKey,
      learnerLicenceNumber: learnerLicenceNumber || null,
      vehicleClasses: vehicleClasses || null
    }})
  ]);
  session.service = both[0].service;
  var created = both[1];
  session.applicationId = created.application.id;
  session.referenceCode = created.application.reference_code;
  // Uploads belong to an application, so a fresh one starts with none.
  session.uploads = {};
  return created.application;
}

// Services that cannot be started without a learner's licence number.
function serviceNeedsLearnerLicence(key){ return key === 'dl'; }

async function startIntake(serviceKey){
  // The permanent licence needs a number the citizen has to type, and the
  // server will not create the application without it — so for that service the
  // row is created when they confirm step 1, not when they pick the card.
  session.applyingClasses = null;
  if(serviceNeedsLearnerLicence(serviceKey)){
    var data = await api('/api/applications/service/' + serviceKey);
    session.service = data.service;
    session.applicationId = null;
    session.referenceCode = null;
    session.uploads = {};
  } else {
    await createApplication(serviceKey);
  }
  session.intakeServiceKey = serviceKey;
  renderIntakeScreen();
  showScreen('screen-intake');
}

// Returns false when step 1 cannot be left yet.
async function completeIntakeDetails(){
  if(!serviceNeedsLearnerLicence(session.intakeServiceKey) || session.applicationId){ return true; }

  var input = document.getElementById('intake-ll-input');
  var errorEl = document.getElementById('intake-ll-error');
  var classErrorEl = document.getElementById('intake-class-error');
  var value = input.value.trim().replace(/\s+/g, ' ').toUpperCase();
  errorEl.hidden = true;
  classErrorEl.hidden = true;

  if(value.length < 6){
    errorEl.textContent = "Enter the number printed on your learner's licence.";
    errorEl.hidden = false;
    input.focus();
    return false;
  }

  var boxes = Array.prototype.slice.call(document.querySelectorAll('[data-class-option]'));
  var classes = boxes.filter(function(b){ return b.checked; }).map(function(b){ return b.value; }).join(', ');
  if(!classes){
    classErrorEl.textContent = 'Choose at least one vehicle class you are applying for.';
    classErrorEl.hidden = false;
    return false;
  }

  try{
    // Set before creating so the checklist rendered on the next step already
    // reflects the classes chosen, including any medical certificate they add.
    session.applyingClasses = classes;
    await createApplication(session.intakeServiceKey, value, classes);
    input.value = value;
    input.readOnly = true;
    boxes.forEach(function(b){ b.disabled = true; });
    return true;
  } catch(err){
    session.applyingClasses = null;
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    return false;
  }
}

function renderPayScreen(){
  var service = session.service;
  document.getElementById('pay-summary-fee').textContent = rupees(service.fee_cents);
  document.getElementById('pay-button').textContent = 'Pay ' + rupees(service.fee_cents) + ' securely';
  var list = document.getElementById('pay-summary-list');
  list.innerHTML =
    '<li><span class="tick">✓</span> ' + service.title + ' (' + service.form_number + ')</li>' +
    '<li><span class="tick">✓</span> Application number: ' + session.referenceCode + '</li>' +
    (service.requires_slot ? '<li><span class="tick">✓</span> Slot: Tue 02 Sep 2026 · RTO ' + session.citizen.rto + '</li>' : '<li><span class="tick">✓</span> No RTO visit required</li>');
  document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = false; });
  var ps = document.getElementById('pay-status'); ps.hidden = true; ps.innerHTML = '';
}

function selectedPaymentMethod(){
  if(document.getElementById('pm-card').checked) return 'Card';
  if(document.getElementById('pm-nb').checked) return 'Net banking';
  return 'UPI';
}

async function processPayment(method, delayMs, onTick){
  session.lastPaymentMethod = method;
  // The amount is deliberately not sent: the server reads the fee from the
  // service so it cannot be talked down by a tampered request. If a charge is
  // already in flight this returns that one (reused) rather than a second.
  var created = await api('/api/payments', { method:'POST', body:{
    applicationId: session.applicationId,
    method: method
  }});

  var tick = null;
  if(delayMs && onTick){
    var secs = 0;
    tick = setInterval(function(){ secs++; onTick(secs); }, 1000);
  }
  await new Promise(function(resolve){ setTimeout(resolve, delayMs || 600); });
  if(tick) clearInterval(tick);

  var confirmed = await api('/api/payments/' + created.payment.id + '/confirm', { method:'POST' });
  return confirmed.payment;
}

async function runPayment(delay){
  document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = true; });
  var status = document.getElementById('pay-status');
  status.hidden = false;
  status.innerHTML = '<div class="spinner" aria-hidden="true"></div>' +
    '<p>Confirming with your bank. This may take up to two minutes. You will not be charged twice, and it is safe to wait or return later.</p>' +
    (delay ? '<p id="pay-timer">Awaiting bank confirmation — 0s</p>' : '');

  try{
    // 4200 is the deliberate "slow bank confirmation" demo and stays slow on
    // purpose; the normal path should not make anyone wait to watch a spinner.
    await processPayment(selectedPaymentMethod(), delay ? 4200 : 600, function(secs){
      var t = document.getElementById('pay-timer');
      if(t) t.textContent = 'Awaiting bank confirmation — ' + secs + 's';
    });
    status.innerHTML = '<div class="stamp">PAYMENT<br>CONFIRMED</div>' +
      '<p class="rec-id" style="text-align:center;">Application number: ' + session.referenceCode + '</p>' +
      '<ul class="checklist payment-notifications">' +
        '<li><span class="tick">✓</span><span><strong>Email sent successfully</strong><br><span class="hint">Receipt and appointment details sent to your email address on file.</span></span></li>' +
        '<li><span class="tick">✓</span><span><strong>Mobile confirmation sent successfully</strong><br><span class="hint">SMS sent to ' + maskMobile(session.citizen.mobile_number) + '.</span></span></li>' +
      '</ul>' +
      '<button class="btn primary" data-action="goto-track">View application status</button>';
  } catch(err){
    status.innerHTML = '<p class="error-text">' + err.message + '</p>';
    document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = false; });
  }
}

function stageIndex(status){
  return { details:0, paid:0, under_review:1, approved:2 }[status] || 0;
}

var APP_STATUS_META = {
  details: { label: 'Details', chip: 'info' },
  paid: { label: 'Paid', chip: 'info' },
  under_review: { label: 'Under review', chip: 'warn' },
  approved: { label: 'Approved', chip: 'ok' },
};
var REC_STAGE_LABELS = ['Submitted', 'Review', 'Approved'];
var REC_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z"/><path d="M14 3v5h5"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="13" y2="17"/></svg>';

function renderTrackScreen(){
  var application = session.application;
  var service = session.service;

  document.getElementById('track-id').textContent = application.reference_code;

  var stages = ['stage-submitted','stage-review','stage-approved'];
  var idx = stageIndex(application.status);
  stages.forEach(function(id, i){
    var el = document.getElementById(id);
    el.classList.remove('done','active');
    if(i < idx) el.classList.add('done');
    else if(i === idx) el.classList.add('active');
  });

  // Track the actual status: this used to claim an officer was verifying
  // documents even at 'details', where the fee is unpaid and nobody has looked
  // at it yet. "Application" rather than "documents" because eKYC applications
  // upload nothing.
  var expectedNote = document.getElementById('expected-note');
  var due = formatDate(application.expected_by);
  if(application.escalated){
    expectedNote.innerHTML = 'An RTO officer is reviewing your application.<br><strong>Now running past the expected ' + due + ' date.</strong>';
  } else if(application.status === 'details'){
    expectedNote.innerHTML = 'Not submitted yet — complete the fee payment to send this for officer review.';
  } else if(application.status === 'approved'){
    expectedNote.innerHTML = '<strong>Approved.</strong> No further action is needed from you.';
  } else {
    expectedNote.innerHTML = (application.status === 'paid'
      ? 'Payment received. Your application is queued for officer review.'
      : 'An RTO officer is reviewing your application.') +
      '<br><strong>Usually ' + service.expected_days + ' working days — expected by ' + due + '.</strong>';
  }
  var escalationBanner = document.getElementById('escalation-banner');
  escalationBanner.hidden = !application.escalated;

  document.getElementById('track-appointment-panel').hidden = !service.requires_slot;

  // session.timeline is still needed for the receipt timestamp even though the
  // timeline is no longer shown as its own panel.
  var payEvent = session.timeline.find(function(evt){ return evt.label.indexOf('Payment confirmed') === 0; });
  document.getElementById('track-confirmation-panel').hidden = !payEvent;
  document.getElementById('confirmation-mobile').textContent = maskMobile(session.citizen.mobile_number);
  document.getElementById('receipt-name').textContent = session.citizen.name;
  document.getElementById('receipt-service').textContent = service.title;
  document.getElementById('receipt-ref').textContent = application.reference_code;
  document.getElementById('receipt-amount').textContent = rupees(service.fee_cents);
  document.getElementById('receipt-method').textContent = session.lastPaymentMethod || '—';
  document.getElementById('receipt-rto').textContent = session.citizen.state + ' · ' + session.citizen.rto;
  document.getElementById('receipt-datetime').textContent = payEvent ? formatDateTime(payEvent.occurred_at) : '—';

  if(service.requires_slot){
    var form1a = computeForm1a(service, session.citizen);
    var appointment = session.selectedSlot || { date: '—', time: '—' };
    document.getElementById('appointment-purpose').textContent = service.slot_purpose
      ? 'A visit is required for ' + service.slot_purpose + '.'
      : 'A visit is required to complete this service.';
    document.getElementById('appointment-location').textContent = 'RTO ' + session.citizen.rto + ', ' + session.citizen.state;
    document.getElementById('appointment-datetime').textContent = appointment.date + ' · ' + appointment.time;
    // Carry items are per service — a first-time learner has no existing
    // licence to bring, which the old hardcoded string asked for.
    var carry = service.carry_items || 'Acknowledgement slip';
    document.getElementById('appointment-carry').textContent = carry + (form1a.required ? ', and completed Form 1A medical certificate' : '');
    renderRtoMap();
  }

  renderApplicationDocuments();
}

function renderApplicationDocuments(){
  var panel = document.getElementById('track-documents-panel');
  var list = document.getElementById('track-documents');
  var docs = session.documents || [];
  if(!docs.length){ panel.hidden = true; return; }

  list.innerHTML = docs.map(function(d){
    return '<li><div><div class="d-name">' + d.label + '</div>' +
      '<div class="d-meta">' + d.mime_type.split('/')[1].toUpperCase() + ' · ' + humanSize(d.size_bytes) + ' · uploaded ' + formatDate(d.uploaded_at) + '</div></div>' +
      '<a class="btn ghost small" href="/api/documents/' + d.id + '/download">Download ↓</a></li>';
  }).join('');
  panel.hidden = false;
}

function renderRtoMap(){
  var wrap = document.getElementById('rto-map');
  var rto = session.rto;
  if(!rto){ wrap.hidden = true; return; }

  var frame = document.getElementById('rto-map-frame');
  if(rto.embedUrl){
    var iframe = document.createElement('iframe');
    iframe.src = rto.embedUrl;
    iframe.loading = 'lazy';
    iframe.referrerPolicy = 'no-referrer-when-downgrade';
    iframe.allowFullscreen = true;
    iframe.title = 'Map showing RTO ' + rto.name;
    frame.innerHTML = '';
    frame.appendChild(iframe);
  } else {
    // No key configured on the server — the directions link still works.
    frame.innerHTML = '<div class="rto-map-fallback">Map preview unavailable.<br>Use “Get directions” to open this office in Google Maps.</div>';
  }

  document.getElementById('rto-map-name').textContent = 'RTO ' + rto.name + (rto.city ? ', ' + rto.city : '') + (rto.state ? ', ' + rto.state : '');
  var hoursEl = document.getElementById('rto-map-hours');
  hoursEl.textContent = rto.hours || '';
  hoursEl.hidden = !rto.hours;
  document.getElementById('rto-map-link').href = rto.mapsLink;
  wrap.hidden = false;
}

function renderSignupRtoMap(rto){
  var wrap = document.getElementById('signup-rto-map');
  if(!rto){ wrap.hidden = true; return; }
  var query = rto.map_query || ('RTO ' + rto.name + ', ' + (rto.city || '') + ', ' + rto.state);
  var encoded = encodeURIComponent(query);
  var iframe = document.createElement('iframe');
  iframe.src = 'https://www.google.com/maps?q=' + encoded + '&output=embed';
  iframe.loading = 'lazy';
  iframe.referrerPolicy = 'no-referrer-when-downgrade';
  iframe.allowFullscreen = true;
  iframe.title = 'Map showing RTO ' + rto.name;
  var frame = document.getElementById('signup-rto-map-frame');
  frame.innerHTML = '';
  frame.appendChild(iframe);
  document.getElementById('signup-rto-map-name').textContent = 'RTO ' + rto.name + (rto.city ? ', ' + rto.city : '') + ', ' + rto.state;
  var hours = document.getElementById('signup-rto-map-hours');
  hours.textContent = rto.hours || '';
  hours.hidden = !rto.hours;
  document.getElementById('signup-rto-map-link').href = 'https://www.google.com/maps/search/?api=1&query=' + encoded;
  wrap.hidden = false;
}

async function openTrack(){
  var data = await api('/api/applications/' + session.applicationId);
  session.application = data.application;
  session.timeline = data.timeline;
  session.rto = data.rto;
  var docs = await api('/api/documents/application/' + session.applicationId);
  session.documents = docs.documents;
  // Always rebuild from the response: it now carries every service field, so
  // this no longer depends on session state or dashboard data-attributes
  // surviving the trip (requires_slot and form_number used to arrive undefined
  // when landing here directly).
  session.service = {
    key: data.application.service_key,
    title: data.application.service_title,
    fee_cents: data.application.fee_cents,
    requires_slot: data.application.requires_slot,
    expected_days: data.application.expected_days,
    form_number: data.application.form_number,
    slot_purpose: data.application.slot_purpose,
    carry_items: data.application.carry_items,
    checklist: data.application.checklist || [],
    eligibility: data.application.eligibility || {}
  };
  renderTrackScreen();
  showScreen('screen-track');
}

async function escalateDemo(){
  await api('/api/applications/' + session.applicationId + '/escalate', { method:'POST' });
  var data = await api('/api/applications/' + session.applicationId);
  session.application = data.application;
  session.timeline = data.timeline;
  session.rto = data.rto;
  renderTrackScreen();
  document.getElementById('escalation-banner').focus();
}

function initials(name){
  return name.split(' ').filter(Boolean).slice(0, 2).map(function(w){ return w[0].toUpperCase(); }).join('');
}

function maskMobile(mobile){
  return '+91 ' + mobile.slice(0, 2) + 'XXXXX' + mobile.slice(-3);
}

var ATTENTION_LABELS = { act: 'Act now', soon: 'Soon', info: 'Heads up' };

// The empty state is the feature, so this panel never hides. "Nothing needs your
// attention" is the whole posture stated outright.
function renderAttention(items){
  var host = document.getElementById('attention-list');
  document.getElementById('attention-count').textContent =
    items.length === 0 ? 'All clear' : items.length + (items.length === 1 ? ' item' : ' items');

  if(!items.length){
    host.innerHTML = '<p class="att-clear">✓ Nothing needs your attention. We will tell you when it does.</p>';
    return;
  }

  host.innerHTML = items.map(function(item){
    var action = item.action
      ? '<button class="btn ghost small" data-action="' + escapeHtml(item.action.type) + '"' +
        (item.action.id ? ' data-id="' + escapeHtml(String(item.action.id)) + '"' : '') + '>' +
        escapeHtml(item.action.label) + '</button>'
      : '';
    return '<div class="att att-' + escapeHtml(item.severity) + '">' +
      '<div class="att-head"><span class="att-sev">' + escapeHtml(ATTENTION_LABELS[item.severity] || item.severity) + '</span>' +
      '<span class="att-title">' + escapeHtml(item.title) + '</span></div>' +
      '<p class="att-detail">' + escapeHtml(item.detail) + '</p>' +
      '<div class="att-foot"><span class="att-source">Because: ' + escapeHtml(item.source) + '</span>' + action + '</div>' +
    '</div>';
  }).join('');
}

async function loadAttention(){
  var data = await api('/api/attention/citizen/' + session.citizen.id);
  session.attention = data.items;
  renderAttention(data.items);
}

// Same shape as downloadReceipt: disable and relabel before the await, but
// always restore the button in a finally so a network drop or a 500 leaves a
// retryable control instead of one stuck reading "Paying…" forever.
async function payChallan(btn){
  var original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Paying…';
  try{
    await api('/api/challans/' + btn.getAttribute('data-id') + '/pay', { method:'POST' });
    await loadAttention();
  } catch(err){
    alert(err.message);
  } finally {
    // loadAttention() replaces this button's markup on success, so restoring
    // it here is a no-op then and only matters on the failure path.
    btn.disabled = false;
    btn.textContent = original;
  }
}

async function openDashboard(){
  document.getElementById('dashboard-name').textContent = session.citizen.name;
  document.getElementById('dashboard-avatar').textContent = initials(session.citizen.name);
  document.getElementById('dashboard-mobile').textContent = maskMobile(session.citizen.mobile_number);
  document.getElementById('dashboard-state').textContent = session.citizen.state + ' · ' + session.citizen.rto + ' RTO';
  document.getElementById('doc-dl-id').textContent = session.citizen.dl_number || '—';
  document.getElementById('doc-holder').textContent = session.citizen.name;

  // You cannot renew or replace a licence you do not hold. Rather than offering
  // services that would dead-end, an account with no licence on record is shown
  // only the one application it can actually make.
  var holdsLicence = Boolean(session.citizen.dl_number);
  document.getElementById('doc-cards').hidden = !holdsLicence;
  document.getElementById('no-licence-panel').hidden = holdsLicence;
  document.querySelectorAll('.dash-side .svc-card').forEach(function(card){
    card.hidden = !holdsLicence && card.getAttribute('data-service') !== 'dl';
  });

  await loadAttention();

  var data = await api('/api/applications/citizen/' + session.citizen.id);

  // Offered only when there is something to attach it to; a lone "not about a
  // specific application" dropdown is just a control the citizen has to read
  // and dismiss. Populated before the early return below so a citizen with no
  // applications can still raise a grievance.
  var linkField = document.getElementById('grievance-link-field');
  var linkSelect = document.getElementById('grievance-application');
  linkSelect.innerHTML = '<option value="">Not about a specific application</option>' +
    data.applications.map(function(app){
      return '<option value="' + app.id + '">' + escapeHtml(app.reference_code + ' · ' + app.service_title) + '</option>';
    }).join('');
  linkField.hidden = data.applications.length === 0;
  resetGrievanceForm();
  await loadGrievances();

  var container = document.getElementById('active-applications');
  if(data.applications.length === 0){
    document.getElementById('app-count').textContent = 'None';
    container.innerHTML = '<p class="hint" style="margin:0;">No applications currently in progress.</p>';
    return;
  }
  document.getElementById('app-count').textContent = data.applications.length + ' in progress';
  container.innerHTML = data.applications.map(function(app){
    var meta = APP_STATUS_META[app.status] || { label: app.status, chip: 'info' };
    var stageIdx = stageIndex(app.status);
    var stepper = '<div class="stage-stepper rec-stepper">' + REC_STAGE_LABELS.map(function(label, i){
      var cls = i < stageIdx ? 'done' : (i === stageIdx ? 'active' : '');
      return '<div class="stage ' + cls + '"><span class="dot"></span>' + label + '</div>';
    }).join('') + '</div>';
    return '<div class="rec' + (app.escalated ? ' escalated' : '') + '">' +
      '<div class="rec-top">' +
        '<div class="rec-top-left">' +
          '<span class="rec-ico">' + REC_ICON + '</span>' +
          '<div><div class="rec-id">' + app.reference_code + '</div><div class="rec-service">' + app.service_title + ' · ' + app.form_number + '</div></div>' +
        '</div>' +
        '<span class="status-chip ' + meta.chip + '">' + meta.label + '</span>' +
      '</div>' +
      (app.escalated ? '<div class="rec-warn">⚠ Escalated to a supervisor — running past the expected date</div>' : '') +
      stepper +
      '<div class="rec-facts">' +
        '<div class="rec-fact"><span class="k">Fee paid</span><span class="v">' + rupees(app.fee_cents) + '</span></div>' +
        '<div class="rec-fact"><span class="k">Submitted</span><span class="v">' + formatDate(app.created_at) + '</span></div>' +
        '<div class="rec-fact"><span class="k">Expected by</span><span class="v">' + formatDate(app.expected_by) + '</span></div>' +
        '<div class="rec-fact"><span class="k">RTO visit</span><span class="v">' + (app.requires_slot ? 'Required' : 'Not required') + '</span></div>' +
      '</div>' +
      '<div class="rec-actions"><button class="btn ghost small" data-action="goto-track" data-app-id="' + app.id + '" data-reference="' + app.reference_code + '" data-service-key="' + app.service_key + '" data-service-title="' + app.service_title + '" data-fee-cents="' + app.fee_cents + '" data-requires-slot="' + app.requires_slot + '" data-expected-days="' + app.expected_days + '" data-form-number="' + app.form_number + '">View status →</button></div>' +
    '</div>';
  }).join('');
}

var GRIEVANCE_STATUS_META = {
  answered: { label: 'Answered', chip: 'ok' },
  open: { label: 'With an officer', chip: 'warn' },
  in_progress: { label: 'In progress', chip: 'warn' },
  closed: { label: 'Closed', chip: 'info' },
};

function escapeHtml(text){
  return String(text == null ? '' : text)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

var GRV_TICK = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5 5L20 6.5"/></svg>';
var GRV_ROUTE = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h13"/><path d="M13 7l5 5-5 5"/></svg>';

// The compact card shown in the sidebar directly under the form, answering what
// was just submitted. The citizen's own words and the model's reply both land in
// innerHTML, so everything rendered here is escaped.
function grievanceOutcome(g){
  return '<div class="grv' + (g.severity === 'high' ? ' urgent' : '') + '">' +
    '<div class="grv-headline ' + (g.answered_immediately ? 'ok' : 'routed') + '">' +
      (g.answered_immediately ? GRV_TICK + 'Answered straight away' : GRV_ROUTE + 'Logged and routed') +
    '</div>' +
    '<div class="grv-top">' +
      '<span class="grv-code">' + escapeHtml(g.ticket_code) + '</span>' +
    '</div>' +
    '<div class="grv-tags">' +
      '<span class="grv-tag">' + escapeHtml(g.category_label) + '</span>' +
      (g.severity === 'high' ? '<span class="grv-tag urgent">Urgent</span>' : '') +
      (g.reference_code ? '<span class="grv-tag">' + escapeHtml(g.reference_code) + '</span>' : '') +
    '</div>' +
    '<p class="grv-reply">' + escapeHtml(g.citizen_reply) + '</p>' +
    '<p class="grv-foot">' +
      (g.answered_immediately
        ? 'Answered from your application record — nothing is queued.'
        : 'Routed to the ' + escapeHtml(g.route_to) + (g.expected_by ? ' · reply due ' + formatDate(g.expected_by) : '')) +
    '</p>' +
  '</div>';
}

var GRV_ROW_ICON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-7a8 8 0 0 1 8-8h2a8 8 0 0 1 8 4Z"/><line x1="10" y1="10" x2="10" y2="13"/><line x1="14" y1="10" x2="14" y2="13"/></svg>';

function triageLabel(g){
  return g.triaged_by === 'openai' ? 'AI triage' : 'keyword fallback';
}

// The wide card for the main column. Deliberately built from the same .rec
// structure as the application cards above it so the two lists read as one
// dashboard rather than two unrelated widgets.
function grievanceRow(g){
  var meta = GRIEVANCE_STATUS_META[g.status] || { label: g.status, chip: 'info' };
  var subtitle = escapeHtml(g.category_label) + (g.reference_code ? ' · ' + escapeHtml(g.reference_code) : '');
  var facts = g.answered_immediately
    ? [['Outcome', 'Answered on the spot'], ['Raised', formatDate(g.created_at)]]
    : [['Routed to', g.route_to || '—'], ['Reply due', g.expected_by ? formatDate(g.expected_by) : '—']];

  return '<div class="rec grv-rec' + (g.severity === 'high' ? ' urgent' : '') + '">' +
    '<div class="rec-top">' +
      '<div class="rec-top-left">' +
        '<span class="rec-ico">' + GRV_ROW_ICON + '</span>' +
        '<div><div class="rec-id">' + escapeHtml(g.ticket_code) + '</div>' +
        '<div class="rec-service">' + subtitle + '</div></div>' +
      '</div>' +
      '<span class="status-chip ' + meta.chip + '">' + meta.label + '</span>' +
    '</div>' +
    (g.severity === 'high' ? '<div class="rec-warn">⚠ Urgent — flagged for a faster reply</div>' : '') +
    // What the citizen actually wrote. The panel never showed it back to them
    // before, so a filed grievance was something they had to remember.
    '<blockquote class="grv-quote">' + escapeHtml(g.body) + '</blockquote>' +
    '<p class="grv-answer">' + escapeHtml(g.citizen_reply) + '</p>' +
    (g.source && g.source !== 'none'
      ? '<p class="grv-source">Answered from: ' + escapeHtml(g.source) + '</p>'
      : '') +
    // The point of the whole feature in one row: the citizen is answered in the
    // language they used, and the desk still gets English. Only worth showing
    // when those two differ.
    (g.language && g.language.toLowerCase() !== 'english'
      ? '<div class="grv-bilingual">' +
          '<span class="grv-lang-tag">Answered in ' + escapeHtml(g.language) + '</span>' +
          '<span class="grv-officer"><strong>The officer sees:</strong> ' + escapeHtml(g.summary) + '</span>' +
        '</div>'
      : '') +
    '<div class="rec-facts">' +
      facts.map(function(f){
        return '<div class="rec-fact"><span class="k">' + f[0] + '</span><span class="v">' + escapeHtml(f[1]) + '</span></div>';
      }).join('') +
    '</div>' +
    '<p class="grv-attrib">Sorted by ' + triageLabel(g) + '</p>' +
  '</div>';
}

// excludeId is the ticket currently shown in the sidebar as the outcome of what
// was just submitted — listing it here too is the same grievance twice.
function renderGrievanceHistory(list, excludeId){
  var host = document.getElementById('grievance-history');
  var panel = document.getElementById('grievance-list-panel');
  var rest = (list || []).filter(function(g){ return g.id !== excludeId; });

  // Hidden outright when empty: an empty panel is a row of chrome telling the
  // citizen nothing, and this one sits directly under their applications.
  panel.hidden = rest.length === 0;
  document.getElementById('grievance-count').textContent =
    rest.length === 1 ? '1 raised' : rest.length + ' raised';
  host.innerHTML = rest.map(grievanceRow).join('');
}

async function loadGrievances(excludeId){
  var data = await api('/api/grievances/citizen/' + session.citizen.id);
  session.grievances = data.grievances;
  renderGrievanceHistory(data.grievances, excludeId);
}

var grievanceMediaRecorder = null;
var grievanceMediaStream = null;
var grievanceAudioChunks = [];
var grievanceRecordingTimer = null;
var grievanceRecordingSeconds = 0;
var grievanceTextBeforeRecording = '';
var grievanceCancelRecording = false;
var grievanceTranscribing = false;

function grievanceTime(seconds){
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

function setGrievanceMode(mode, cancelRecording){
  var voice = mode === 'voice';
  document.getElementById('grievance-type-input').hidden = voice;
  document.getElementById('grievance-voice-input').hidden = !voice;
  document.getElementById('grievance-type-tab').classList.toggle('active', !voice);
  document.getElementById('grievance-voice-tab').classList.toggle('active', voice);
  document.getElementById('grievance-type-tab').setAttribute('aria-selected', String(!voice));
  document.getElementById('grievance-voice-tab').setAttribute('aria-selected', String(voice));
  if(!voice) stopGrievanceRecording(Boolean(cancelRecording));
}

function finishGrievanceRecording(label){
  clearInterval(grievanceRecordingTimer);
  grievanceRecordingTimer = null;
  document.getElementById('grievance-mic-dot').classList.remove('live');
  document.getElementById('grievance-record-start').hidden = false;
  document.getElementById('grievance-record-stop').hidden = true;
  document.getElementById('grievance-recording-label').textContent = label || 'Recording stopped';
}

function releaseGrievanceMicrophone(){
  if(grievanceMediaStream){
    grievanceMediaStream.getTracks().forEach(function(track){ track.stop(); });
    grievanceMediaStream = null;
  }
}

function stopGrievanceRecording(cancel){
  grievanceCancelRecording = Boolean(cancel);
  if(grievanceMediaRecorder && grievanceMediaRecorder.state !== 'inactive'){
    grievanceMediaRecorder.stop();
    return;
  }
  grievanceMediaRecorder = null;
  releaseGrievanceMicrophone();
  finishGrievanceRecording();
}

async function transcribeGrievanceAudio(blob){
  var errorEl = document.getElementById('grievance-error');
  var startButton = document.getElementById('grievance-record-start');
  grievanceTranscribing = true;
  startButton.disabled = true;
  document.getElementById('grievance-recording-label').textContent = 'Reading your recording…';
  document.getElementById('grievance-transcript').textContent = 'Turning your recording into text…';
  try{
    var response = await fetch('/api/transcriptions/grievance', {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob
    });
    var data = {};
    try{ data = await response.json(); } catch(e){}
    if(!response.ok) throw new Error(data.error || 'The recording could not be read.');
    // Whisper reports the language it heard. Carried through to the triage so
    // the reply comes back in it rather than defaulting to English.
    session.grievanceLanguage = data.language || null;
    var text = ((grievanceTextBeforeRecording ? grievanceTextBeforeRecording + ' ' : '') + data.text).trim().slice(0, 2000);
    var field = document.getElementById('grievance-body');
    field.value = text;
    var transcript = document.getElementById('grievance-transcript');
    transcript.textContent = text;
    transcript.classList.add('has-text');
    document.getElementById('grievance-recording-label').textContent = 'Ready';
  } catch(err){
    errorEl.textContent = err.message;
    errorEl.hidden = false;
    document.getElementById('grievance-recording-label').textContent = 'Could not read the recording';
    document.getElementById('grievance-transcript').textContent = grievanceTextBeforeRecording || 'Try recording again or type your grievance.';
  } finally {
    grievanceTranscribing = false;
    startButton.disabled = false;
  }
}

async function startGrievanceRecording(){
  var errorEl = document.getElementById('grievance-error');
  if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder){
    errorEl.textContent = 'Audio recording is not supported in this browser. Please use a current browser or type your grievance.';
    errorEl.hidden = false;
    return;
  }
  errorEl.hidden = true;
  stopGrievanceRecording(true);
  grievanceCancelRecording = false;
  grievanceAudioChunks = [];
  grievanceTextBeforeRecording = document.getElementById('grievance-body').value.trim();
  grievanceRecordingSeconds = 0;
  try{
    grievanceMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    var preferred = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    grievanceMediaRecorder = preferred
      ? new MediaRecorder(grievanceMediaStream, { mimeType: preferred })
      : new MediaRecorder(grievanceMediaStream);
    grievanceMediaRecorder.ondataavailable = function(event){
      if(event.data && event.data.size) grievanceAudioChunks.push(event.data);
    };
    grievanceMediaRecorder.onstop = async function(){
      var mimeType = grievanceMediaRecorder.mimeType || (grievanceAudioChunks[0] && grievanceAudioChunks[0].type) || 'audio/webm';
      var blob = new Blob(grievanceAudioChunks, { type: mimeType });
      grievanceMediaRecorder = null;
      releaseGrievanceMicrophone();
      finishGrievanceRecording(grievanceCancelRecording ? 'Ready to record' : 'Recording complete');
      if(!grievanceCancelRecording && blob.size) await transcribeGrievanceAudio(blob);
    };
    grievanceMediaRecorder.start(250);
    document.getElementById('grievance-recording-time').textContent = '00:00';
    document.getElementById('grievance-recording-label').textContent = 'Recording…';
    document.getElementById('grievance-mic-dot').classList.add('live');
    document.getElementById('grievance-record-start').hidden = true;
    document.getElementById('grievance-record-stop').hidden = false;
    grievanceRecordingTimer = setInterval(function(){
      grievanceRecordingSeconds++;
      document.getElementById('grievance-recording-time').textContent = grievanceTime(grievanceRecordingSeconds);
      if(grievanceRecordingSeconds >= 120) stopGrievanceRecording(false);
    }, 1000);
  } catch(err){
    releaseGrievanceMicrophone();
    finishGrievanceRecording('Ready to record');
    errorEl.textContent = 'Microphone permission was denied. Allow microphone access or type your grievance.';
    errorEl.hidden = false;
  }
}

async function submitGrievance(btn){
  var field = document.getElementById('grievance-body');
  var errorEl = document.getElementById('grievance-error');
  var text = field.value.trim();
  errorEl.hidden = true;

  if(text.length < 10){
    errorEl.textContent = 'Please describe the problem in a sentence or two so it reaches the right desk.';
    errorEl.hidden = false;
    field.focus();
    return;
  }

  var original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Reading your complaint…';
  try{
    var select = document.getElementById('grievance-application');
    var data = await api('/api/grievances', { method:'POST', body:{
      citizenId: session.citizen.id,
      mobileNumber: session.citizen.mobile_number,
      applicationId: select && select.value ? Number(select.value) : null,
      body: text,
      language: session.grievanceLanguage || null
    }});

    // The form is replaced by the outcome rather than clearing to an empty box,
    // so it is obvious the complaint was actually read and what became of it.
    document.getElementById('grievance-form').hidden = true;
    var result = document.getElementById('grievance-result');
    result.hidden = false;
    result.innerHTML = grievanceOutcome(data.grievance) +
      '<button class="btn ghost small" data-action="grievance-again">Raise another</button>';
    if(select) select.value = '';
    field.value = '';
    await loadGrievances(data.grievance.id);
  } catch(err){
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

// focusField only when the citizen asked for the form back — on a plain
// dashboard load, moving focus here would yank the page down to the sidebar.
function resetGrievanceForm(focusField){
  setGrievanceMode('type', true);
  document.getElementById('grievance-result').hidden = true;
  document.getElementById('grievance-form').hidden = false;
  document.getElementById('grievance-error').hidden = true;
  var transcript = document.getElementById('grievance-transcript');
  var text = document.getElementById('grievance-body').value.trim();
  transcript.textContent = text || 'Your words will appear here after recording.';
  transcript.classList.toggle('has-text', Boolean(text));
  if(focusField) document.getElementById('grievance-body').focus();
}

// Start/end for each bookable window. Kept as an explicit table rather than
// parsed out of the display label, whose en-dash and trailing meridiem ("3:00–
// 4:00 PM") make parsing needlessly fragile.
var CAL_TIME_RANGES = {
  '10:00–11:00 AM': { start: '100000', end: '110000' },
  '12:00–1:00 PM': { start: '120000', end: '130000' },
  '3:00–4:00 PM': { start: '150000', end: '160000' },
};

function icsEscape(text){
  return String(text).replace(/([,;\\])/g, '\\$1');
}

async function downloadReceipt(btn){
  var original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try{
    var res = await fetch('/api/applications/' + session.applicationId + '/receipt.pdf');
    if(res.status === 501){
      // Server has no Adobe credentials — the print dialog still produces a
      // usable PDF, so fall through to it rather than dead-ending.
      btn.textContent = original;
      window.print();
      return;
    }
    if(!res.ok){
      var data = {};
      try { data = await res.json(); } catch(e) {}
      throw new Error(data.error || 'Could not generate the receipt.');
    }
    var blob = await res.blob();
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'receipt-' + (session.referenceCode || 'sarathi') + '.pdf';
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  } catch(err){
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

function downloadIcs(){
  var service = session.service || {};
  var slot = session.selectedSlot;
  if(!slot){
    alert('Pick an appointment slot first — there is nothing to add to your calendar yet.');
    return;
  }

  var day = new Date(slot.date);
  if(isNaN(day.getTime())){
    alert('Could not read the appointment date.');
    return;
  }
  var stamp = day.getFullYear() +
    String(day.getMonth() + 1).padStart(2, '0') +
    String(day.getDate()).padStart(2, '0');
  var range = CAL_TIME_RANGES[slot.time] || { start: '100000', end: '110000' };

  var summary = 'RTO visit — ' + (service.title || 'driving licence service');
  var description = 'Carry: ' + (service.carry_items || 'Acknowledgement slip') +
    '. Application number: ' + (session.referenceCode || '—') + '.';
  var location = 'RTO ' + session.citizen.rto + ', ' + session.citizen.state;

  var ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'SUMMARY:' + icsEscape(summary),
    'DESCRIPTION:' + icsEscape(description),
    'LOCATION:' + icsEscape(location),
    'DTSTART:' + stamp + 'T' + range.start,
    'DTEND:' + stamp + 'T' + range.end,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  var blob = new Blob([ics], {type:'text/calendar'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'rto-visit.ics';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

var fontScale = 100;
function applyFont(){ document.documentElement.style.fontSize = fontScale + '%'; }

async function handleAction(action, el){
  try{
    if(action === 'connect-digilocker'){
      var startMobile = document.getElementById('signup-mobile-start').value.trim();
      var startMobileError = document.getElementById('signup-mobile-start-error');
      if(!/^\d{10}$/.test(startMobile)){
        startMobileError.hidden = false;
        return;
      }
      startMobileError.hidden = true;
      session.signupMobile = startMobile;
      var digilockerButton = document.getElementById('digilocker-button');
      var digilockerStatus = document.getElementById('digilocker-status');
      digilockerButton.hidden = true;
      digilockerStatus.hidden = false;
      digilockerStatus.textContent = 'OTP sent successfully to +91 ' + startMobile + '.';
      document.getElementById('signup-aadhaar-otp-mobile').textContent = '+91 ' + startMobile;
      document.getElementById('signup-aadhaar-otp').hidden = false;
      document.getElementById('signup-aadhaar-otp-input').focus();
    }
    else if(action === 'verify-digilocker-otp'){
      var aadhaarOtp = document.getElementById('signup-aadhaar-otp-input').value.trim();
      var aadhaarOtpError = document.getElementById('signup-aadhaar-otp-error');
      if(aadhaarOtp !== '123456'){
        aadhaarOtpError.hidden = false;
        return;
      }
      aadhaarOtpError.hidden = true;
      var verifyOtpButton = document.getElementById('verify-digilocker-otp-button');
      var digilockerStatus = document.getElementById('digilocker-status');
      verifyOtpButton.disabled = true;
      verifyOtpButton.textContent = 'Verified';
      document.getElementById('signup-aadhaar-otp').hidden = true;
      digilockerStatus.hidden = false;
      digilockerStatus.innerHTML = '<div class="digilocker-fetching"><span class="fetch-spinner" aria-hidden="true"></span><span><strong>Fetching your details…</strong><br>Reading your Aadhaar profile from DigiLocker.</span></div>';
      // A real eKYC round trip is not instant, so the fetch is paced rather than
      // faked away — but five seconds was theatre the citizen had to sit through.
      await delay(1200);

      document.getElementById('signup-name').value = 'Tarun Kesava Menon';
      document.getElementById('signup-email').value = 'tarun.menon@example.com';
      document.getElementById('signup-mobile').value = session.signupMobile;
      document.getElementById('signup-dob').value = '1999-06-14';
      document.getElementById('signup-pincode').value = '500076';
      document.getElementById('signup-address').value = 'Plot 12, Habsiguda, Hyderabad, Telangana';

      var resolvedRto = await api('/api/rtos/resolve?pincode=500076');
      if(resolvedRto.resolved && resolvedRto.rto){
        document.getElementById('signup-rto').value = String(resolvedRto.rto.id);
        renderSignupRtoMap(resolvedRto.rto);
      }
      digilockerStatus.textContent = 'DigiLocker linked successfully. Your Aadhaar details are ready for review.';
      document.getElementById('signup-form-panel').hidden = false;
      document.getElementById('signup-form-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    else if(action === 'register'){
      var signupError = document.getElementById('signup-error');
      var signupButton = document.getElementById('signup-button');
      var registration = {
        name: document.getElementById('signup-name').value.trim(),
        email: document.getElementById('signup-email').value.trim(),
        mobile: document.getElementById('signup-mobile').value.trim(),
        dob: document.getElementById('signup-dob').value,
        pincode: document.getElementById('signup-pincode').value.trim(),
        rtoId: document.getElementById('signup-rto').value,
        address: document.getElementById('signup-address').value.trim()
      };
      signupError.hidden = true;
      document.getElementById('signup-consent-wrap').classList.remove('ack-missing');
      if(!registration.name || !registration.email || !/^\d{10}$/.test(registration.mobile) || !registration.dob || !/^\d{6}$/.test(registration.pincode) || !registration.address){
        signupError.textContent = 'Complete all required fields with valid information.';
        signupError.hidden = false;
        return;
      }
      if(!document.getElementById('signup-consent').checked){
        document.getElementById('signup-consent-wrap').classList.add('ack-missing');
        signupError.textContent = 'Please confirm that your details are correct.';
        signupError.hidden = false;
        return;
      }
      signupButton.disabled = true;
      signupButton.textContent = 'Creating account…';
      var registered = await api('/api/auth/register', { method:'POST', body: registration });
      session.citizen = registered.citizen;
      localStorage.setItem('setu_citizen', JSON.stringify(registered.citizen));
      await syncAndShowDashboard();
    }
    else if(action === 'send-otp'){
      var m = document.getElementById('mobile-input');
      if(!/^\d{10}$/.test(m.value.trim())){ document.getElementById('mobile-error').hidden=false; return; }
      await api('/api/auth/send-otp', { method:'POST', body:{ mobile: m.value.trim() } });
      session.mobile = m.value.trim();
      document.getElementById('mobile-error').hidden=true;
      document.getElementById('otp-step').hidden=false;
      document.getElementById('otp-phone-label').textContent='+91 '+m.value.trim();
      document.getElementById('otp-input').focus();
    }
    else if(action === 'verify-otp'){
      var otp = document.getElementById('otp-input').value.trim();
      var data = await api('/api/auth/verify-otp', { method:'POST', body:{ mobile: session.mobile, otp: otp } });
      document.getElementById('otp-error').hidden = true;
      session.citizen = data.citizen;
      localStorage.setItem('setu_citizen', JSON.stringify(data.citizen));
      if(session.pendingService){
        var s = session.pendingService; session.pendingService = null;
        await startIntake(s);
      } else {
        await syncAndShowDashboard();
      }
    }
    else if(action === 'start-intake'){
      var s2 = el.getAttribute('data-service') || 'renew';
      if(!session.citizen){ session.pendingService = s2; showScreen('screen-login'); return; }
      await startIntake(s2);
    }
    else if(action === 'intake-next'){
      // Step 1 is where the application actually gets created for services that
      // need a typed licence number, so it can refuse to advance.
      if(intakeSubstep === 1 && !(await completeIntakeDetails())){ return; }
      intakeSubstep = Math.min(3, intakeSubstep + 1);
      renderIntakeSubsteps();
    }
    else if(action === 'intake-back'){ intakeSubstep = Math.max(1, intakeSubstep - 1); renderIntakeSubsteps(); }
    else if(action === 'goto-pay'){
      if(session.service.requires_slot && !session.selectedSlot){
        document.getElementById('cal-slot-summary').textContent = 'Please pick a date and time above to continue.';
        return;
      }
      var ackRow = document.getElementById('intake-road-safety');
      if(!ackRow.hidden && !document.getElementById('road-safety-check').checked){
        ackRow.classList.add('ack-missing');
        return;
      }
      renderPayScreen();
      showScreen('screen-pay');
    }
    else if(action === 'pay-now'){ await runPayment(false); }
    else if(action === 'pay-delay-demo'){ await runPayment(true); }
    else if(action === 'goto-track'){
      if(!session.applicationId && !(el && el.dataset && el.dataset.appId)){
        alert('No application to show yet.');
        return;
      }
      if(el && el.dataset && el.dataset.appId){
        session.applicationId = el.dataset.appId;
        session.referenceCode = el.dataset.reference;
        session.service = {
          key: el.dataset.serviceKey,
          title: el.dataset.serviceTitle,
          fee_cents: Number(el.dataset.feeCents),
          requires_slot: el.dataset.requiresSlot === 'true',
          expected_days: Number(el.dataset.expectedDays),
          form_number: el.dataset.formNumber,
          checklist: [],
          eligibility: {}
        };
      }
      await openTrack();
    }
    else if(action === 'goto-dashboard'){ await openDashboard(); showScreen('screen-dashboard'); }
    else if(action === 'goto-signup'){
      document.getElementById('signup-button').disabled = false;
      document.getElementById('signup-button').textContent = 'Create account';
      document.getElementById('signup-error').hidden = true;
      var rtoSelect = document.getElementById('signup-rto');
      if(!rtoSelect.getAttribute('data-loaded')){
        var rtoData = await api('/api/rtos');
        session.signupRtos = rtoData.rtos;
        rtoSelect.innerHTML = '<option value="">Select your RTO</option>' + rtoData.rtos.map(function(rto){
          return '<option value="' + rto.id + '">' + rto.name + ' — ' + rto.city + ', ' + rto.state + '</option>';
        }).join('');
        rtoSelect.setAttribute('data-loaded', 'true');
      }
      if(!rtoSelect.getAttribute('data-map-listener')){
        rtoSelect.addEventListener('change', function(){
          var selectedRto = (session.signupRtos || []).find(function(rto){ return String(rto.id) === rtoSelect.value; });
          renderSignupRtoMap(selectedRto || null);
        });
        rtoSelect.setAttribute('data-map-listener', 'true');
      }
      showScreen('screen-signup');
    }
    else if(action === 'goto-login'){ showScreen('screen-login'); }
    else if(action === 'goto-home'){ showScreen('screen-home'); }
    else if(action === 'logout'){
      localStorage.removeItem('setu_citizen');
      session.citizen = null; session.applicationId = null; session.referenceCode = null; session.service = null; session.application = null;
      showScreen('screen-home');
    }
    else if(action === 'grievance-mode-type'){ setGrievanceMode('type'); document.getElementById('grievance-body').focus(); }
    else if(action === 'grievance-mode-voice'){ setGrievanceMode('voice'); }
    else if(action === 'start-grievance-recording'){ startGrievanceRecording(); }
    else if(action === 'stop-grievance-recording'){ stopGrievanceRecording(); }
    else if(action === 'submit-grievance'){
      if((grievanceMediaRecorder && grievanceMediaRecorder.state !== 'inactive') || grievanceTranscribing){
        var recordingError = document.getElementById('grievance-error');
        recordingError.textContent = grievanceTranscribing ? 'Wait for the transcription to finish before submitting.' : 'Stop the recording and wait for the transcription before submitting.';
        recordingError.hidden = false;
        return;
      }
      await submitGrievance(el);
    }
    // The outcome card is going away, so the ticket it was holding rejoins the
    // history rather than disappearing from the panel entirely.
    else if(action === 'grievance-again'){ resetGrievanceForm(true); renderGrievanceHistory(session.grievances); }
    else if(action === 'escalate-demo'){ await escalateDemo(); }
    else if(action === 'add-calendar'){ downloadIcs(); }
    else if(action === 'print-receipt'){ window.print(); }
    else if(action === 'download-receipt'){ await downloadReceipt(el); }
    else if(action === 'pay-challan'){ await payChallan(el); }
    else if(action === 'toggle-lang'){ document.body.classList.toggle('lang-hi'); }
    else if(action === 'font-inc'){ fontScale = Math.min(130, fontScale+10); applyFont(); }
    else if(action === 'font-dec'){ fontScale = Math.max(90, fontScale-10); applyFont(); }
    else if(action === 'font-reset'){ fontScale = 100; applyFont(); }
  } catch(err){
    if(action === 'verify-digilocker-otp'){
      document.getElementById('digilocker-status').textContent = 'Could not fetch your details. Please try again.';
      document.getElementById('signup-aadhaar-otp').hidden = false;
      var retryOtpButton = document.getElementById('verify-digilocker-otp-button');
      retryOtpButton.disabled = false;
      retryOtpButton.textContent = 'Verify OTP';
    }
    else if(action === 'register'){
      var registerError = document.getElementById('signup-error');
      registerError.textContent = err.message;
      registerError.hidden = false;
      var registerButton = document.getElementById('signup-button');
      registerButton.disabled = false;
      registerButton.textContent = 'Create account';
    }
    else if(action === 'verify-otp'){ document.getElementById('otp-error').hidden = false; document.getElementById('otp-error').textContent = err.message; }
    else { alert(err.message); }
  }
}

document.addEventListener('DOMContentLoaded', function(){
  document.body.addEventListener('click', function(e){
    var t = e.target.closest('[data-action]');
    if(!t) return;
    if(t.tagName === 'A') e.preventDefault();
    handleAction(t.getAttribute('data-action'), t);
  });
  initDocCardTilt();

  var saved = localStorage.getItem('setu_citizen');
  if(saved){
    session.citizen = JSON.parse(saved);
    syncAndShowDashboard();
  }
});
