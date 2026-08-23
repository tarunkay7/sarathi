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
  await Promise.all([openDashboard(), delay(1400)]);
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

function computeForm1a(service, citizen){
  var eligibility = (service && service.eligibility) || {};
  var minAge = eligibility.form1aMinAge;
  var keywords = eligibility.transportCategoryKeywords || [];
  var vehicleClasses = (citizen && citizen.vehicle_classes) || '';
  var isTransportCategory = keywords.some(function(word){ return vehicleClasses.indexOf(word) !== -1; });

  if(isTransportCategory){
    return { required: true, reason: 'required, your licence covers a Transport Category vehicle' };
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
  document.getElementById('intake-vehicle-class').textContent = session.citizen.vehicle_classes || '—';

  var list = document.getElementById('intake-checklist');
  list.innerHTML = '';
  service.checklist.forEach(function(item){
    var li = document.createElement('li');
    li.innerHTML = '<span class="tick">✓</span> ' + item.label + (item.badge ? ' <span class="doc-badge">' + item.badge + '</span>' : '');
    list.appendChild(li);
  });
  var form1a = document.createElement('li');
  form1a.className = 'extra';
  form1a.id = 'form1a-line';
  form1a.hidden = true;
  form1a.innerHTML = '<span class="tick">✓</span> Medical certificate (Form 1A) — <strong id="form1a-reason">required</strong>';
  list.appendChild(form1a);

  document.getElementById('intake-fee-label').textContent = service.title + ' (' + service.form_number + ')';
  document.getElementById('intake-fee-amount').textContent = rupees(service.fee_cents);
  document.getElementById('intake-slot-section').hidden = !service.requires_slot;
  document.getElementById('intake-no-slot').hidden = !!service.requires_slot;

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

async function createApplication(serviceKey){
  var data = await api('/api/applications/service/' + serviceKey);
  session.service = data.service;
  var created = await api('/api/applications', { method:'POST', body:{ citizenId: session.citizen.id, serviceKey: serviceKey } });
  session.applicationId = created.application.id;
  session.referenceCode = created.application.reference_code;
  return created.application;
}

async function startIntake(serviceKey){
  await createApplication(serviceKey);
  renderIntakeScreen();
  showScreen('screen-intake');
}

function renderPayScreen(){
  var service = session.service;
  document.getElementById('pay-summary-fee').textContent = rupees(service.fee_cents);
  document.getElementById('pay-button').textContent = 'Pay ' + rupees(service.fee_cents) + ' securely';
  var list = document.getElementById('pay-summary-list');
  list.innerHTML =
    '<li><span class="tick">✓</span> ' + service.title + ' (' + service.form_number + ')</li>' +
    '<li><span class="tick">✓</span> Reference: ' + session.referenceCode + '</li>' +
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
  var created = await api('/api/payments', { method:'POST', body:{
    applicationId: session.applicationId,
    amountCents: session.service.fee_cents,
    method: method
  }});

  var tick = null;
  if(delayMs && onTick){
    var secs = 0;
    tick = setInterval(function(){ secs++; onTick(secs); }, 1000);
  }
  await new Promise(function(resolve){ setTimeout(resolve, delayMs || 1200); });
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
    await processPayment(selectedPaymentMethod(), delay ? 4200 : 1200, function(secs){
      var t = document.getElementById('pay-timer');
      if(t) t.textContent = 'Awaiting bank confirmation — ' + secs + 's';
    });
    status.innerHTML = '<div class="stamp">PAYMENT<br>CONFIRMED</div>' +
      '<p class="rec-id" style="text-align:center;">Reference: ' + session.referenceCode + '</p>' +
      '<button class="btn primary" data-action="goto-track">View application status</button>';
  } catch(err){
    status.innerHTML = '<p class="error-text">' + err.message + '</p>';
    document.querySelectorAll('.pay-trigger').forEach(function(b){ b.disabled = false; });
  }
}

function stageIndex(status){
  return { details:0, paid:0, under_review:1, approved:2, ready:3 }[status] || 0;
}

function renderTrackScreen(){
  var application = session.application;
  var service = session.service;

  document.getElementById('track-id').textContent = application.reference_code;

  var stages = ['stage-submitted','stage-review','stage-approved','stage-ready'];
  var idx = stageIndex(application.status);
  stages.forEach(function(id, i){
    var el = document.getElementById(id);
    el.classList.remove('done','active');
    if(i < idx) el.classList.add('done');
    else if(i === idx) el.classList.add('active');
  });

  var expectedNote = document.getElementById('expected-note');
  if(application.escalated){
    expectedNote.innerHTML = 'An RTO officer is verifying your documents.<br><strong>Now running past the expected ' + formatDate(application.expected_by) + ' date.</strong>';
  } else {
    expectedNote.innerHTML = 'An RTO officer is verifying your documents. This stage usually takes ' + service.expected_days + ' working days.<br><strong>Expected completion by ' + formatDate(application.expected_by) + '.</strong>';
  }
  var escalationBanner = document.getElementById('escalation-banner');
  escalationBanner.hidden = !application.escalated;

  var log = document.getElementById('timeline-log');
  log.innerHTML = '';
  session.timeline.forEach(function(evt){
    var li = document.createElement('li');
    li.textContent = evt.label + ' · ' + formatDateTime(evt.occurred_at);
    log.appendChild(li);
  });

  document.getElementById('track-appointment-panel').hidden = !service.requires_slot;

  var payEvent = session.timeline.find(function(evt){ return evt.label.indexOf('Payment confirmed') === 0; });
  document.getElementById('receipt-name').textContent = session.citizen.name;
  document.getElementById('receipt-service').textContent = service.title;
  document.getElementById('receipt-ref').textContent = application.reference_code;
  document.getElementById('receipt-amount').textContent = rupees(service.fee_cents);
  document.getElementById('receipt-method').textContent = session.lastPaymentMethod || '—';
  document.getElementById('receipt-rto').textContent = session.citizen.state + ' · ' + session.citizen.rto;
  document.getElementById('receipt-datetime').textContent = payEvent ? formatDateTime(payEvent.occurred_at) : '—';
}

async function openTrack(){
  var data = await api('/api/applications/' + session.applicationId);
  session.application = data.application;
  session.timeline = data.timeline;
  if(!session.service || session.service.key !== data.application.service_key){
    session.service = {
      key: data.application.service_key,
      title: data.application.service_title,
      fee_cents: data.application.fee_cents,
      requires_slot: data.application.requires_slot,
      expected_days: data.application.expected_days,
      form_number: data.application.form_number,
      checklist: [],
      eligibility: {}
    };
  }
  renderTrackScreen();
  showScreen('screen-track');
}

async function escalateDemo(){
  await api('/api/applications/' + session.applicationId + '/escalate', { method:'POST' });
  var data = await api('/api/applications/' + session.applicationId);
  session.application = data.application;
  session.timeline = data.timeline;
  renderTrackScreen();
  document.getElementById('escalation-banner').focus();
}

function initials(name){
  return name.split(' ').filter(Boolean).slice(0, 2).map(function(w){ return w[0].toUpperCase(); }).join('');
}

function maskMobile(mobile){
  return '+91 ' + mobile.slice(0, 2) + 'XXXXX' + mobile.slice(-3);
}

async function openDashboard(){
  document.getElementById('dashboard-name').textContent = session.citizen.name;
  document.getElementById('dashboard-avatar').textContent = initials(session.citizen.name);
  document.getElementById('dashboard-profile-name').textContent = session.citizen.name;
  document.getElementById('dashboard-mobile').textContent = maskMobile(session.citizen.mobile_number);
  document.getElementById('dashboard-state').textContent = session.citizen.state + ' · ' + session.citizen.rto + ' RTO';
  document.getElementById('doc-dl-id').textContent = session.citizen.dl_number || '—';
  document.getElementById('doc-holder').textContent = session.citizen.name;

  var data = await api('/api/applications/citizen/' + session.citizen.id);
  var container = document.getElementById('active-applications');
  if(data.applications.length === 0){
    document.getElementById('app-count').textContent = 'None';
    container.innerHTML = '<p class="hint" style="margin:0;">No applications currently in progress.</p>';
    return;
  }
  document.getElementById('app-count').textContent = data.applications.length + ' in progress';
  container.innerHTML = data.applications.map(function(app){
    var statusLabel = { details:'Details', paid:'Paid', under_review:'Under review', approved:'Approved', ready:'Ready' }[app.status] || app.status;
    return '<div class="rec"><div class="rec-top"><span class="rec-id">' + app.reference_code + '</span>' +
      '<span class="status-chip info">' + statusLabel + (app.escalated ? ' · escalated' : '') + '</span></div>' +
      '<div class="rec-body"><div class="kv"><span class="k">Service</span><span>' + app.service_title + '</span></div>' +
      '<div class="kv"><span class="k">Expected by</span><span>' + formatDate(app.expected_by) + '</span></div></div>' +
      '<div class="rec-actions"><button class="btn ghost small" data-action="goto-track" data-app-id="' + app.id + '" data-reference="' + app.reference_code + '" data-service-key="' + app.service_key + '" data-service-title="' + app.service_title + '" data-fee-cents="' + app.fee_cents + '" data-requires-slot="' + app.requires_slot + '" data-expected-days="' + app.expected_days + '" data-form-number="' + app.form_number + '">View status</button></div></div>';
  }).join('');
}

function downloadIcs(){
  var ics = 'BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VEVENT\nSUMMARY:RTO visit - driving licence service\nDESCRIPTION:Carry acknowledgment slip\\, Form 1A\\, and existing licence.\nLOCATION:RTO Kukatpally\\, Hyderabad\nDTSTART:20260902T100000\nDTEND:20260902T110000\nEND:VEVENT\nEND:VCALENDAR';
  var blob = new Blob([ics], {type:'text/calendar'});
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url; a.download = 'rto-visit.ics';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

var fontScale = 100;
function applyFont(){ document.documentElement.style.fontSize = fontScale + '%'; }

var voicePC = null;
var voiceStream = null;
var voiceDC = null;
var voiceCaptionBuffer = '';

var VOICE_INNER_ORDER = ['details', 'documents', 'slot'];

var voiceCaptionRAF = null;

function setVoiceCaption(text){
  document.getElementById('voice-caption').textContent = text;
}

function scheduleVoiceCaptionUpdate(){
  if(voiceCaptionRAF) return;
  voiceCaptionRAF = requestAnimationFrame(function(){
    voiceCaptionRAF = null;
    setVoiceCaption(voiceCaptionBuffer);
  });
}

function setVoiceUserCaption(text){
  document.getElementById('voice-caption-user').textContent = text ? ('You said: "' + text + '"') : '';
}

function renderVoiceProgress(phase){
  VOICE_INNER_ORDER.forEach(function(key, i){
    var el = document.querySelector('#voice-inner-steps [data-vinner="' + key + '"]');
    var idx = VOICE_INNER_ORDER.indexOf(phase);
    el.classList.remove('done', 'active');
    if(idx === -1){ el.classList.add('done'); }
    else if(i < idx) el.classList.add('done');
    else if(i === idx) el.classList.add('active');
  });
  var outerDetails = document.querySelector('#voice-outer-steps [data-vouter="details"]');
  var outerPay = document.querySelector('#voice-outer-steps [data-vouter="pay"]');
  var outerTrack = document.querySelector('#voice-outer-steps [data-vouter="track"]');
  [outerDetails, outerPay, outerTrack].forEach(function(el){ el.classList.remove('done', 'active'); });
  if(phase === 'payment'){ outerDetails.classList.add('done'); outerPay.classList.add('active'); }
  else if(phase === 'track'){ outerDetails.classList.add('done'); outerPay.classList.add('done'); outerTrack.classList.add('active'); }
  else { outerDetails.classList.add('active'); }

  renderVoiceDetail(phase);
}

function renderVoiceDetail(phase){
  var el = document.getElementById('voice-detail');
  var citizen = session.citizen;
  var service = session.service;
  if(!citizen || !service){ return; }
  el.classList.remove('voice-caption-fade');
  void el.offsetWidth;
  el.classList.add('voice-caption-fade');

  if(phase === 'details'){
    el.innerHTML =
      '<div class="infogrid" style="margin-bottom:0;">' +
        '<div class="cell"><span class="k">Applicant</span><span class="v">' + citizen.name + '</span></div>' +
        '<div class="cell auto"><span class="k">State / RTO</span><span class="v">' + citizen.state + ' · ' + citizen.rto + '</span></div>' +
        '<div class="cell"><span class="k">DL number</span><span class="v">' + (citizen.dl_number || '—') + '</span></div>' +
        '<div class="cell auto"><span class="k">Date of birth</span><span class="v">' + (citizen.dob ? formatDate(citizen.dob) : '—') + '</span></div>' +
        '<div class="cell auto"><span class="k">Licence class</span><span class="v">' + (citizen.vehicle_classes || '—') + '</span></div>' +
      '</div>';
  }
  else if(phase === 'documents'){
    var form1a = computeForm1a(service, citizen);
    var items = service.checklist.map(function(item){
      return '<li><span class="tick">✓</span> ' + item.label + (item.badge ? ' <span class="doc-badge">' + item.badge + '</span>' : '') + '</li>';
    }).join('');
    if(form1a.required){
      items += '<li class="extra"><span class="tick">✓</span> Medical certificate (Form 1A) — <strong>' + form1a.reason + '</strong></li>';
    }
    el.innerHTML = '<ul class="checklist" style="margin:0;">' + items + '</ul>';
  }
  else if(phase === 'slot'){
    el.innerHTML =
      '<table class="fee-table" style="margin:0;"><tr><td>' + service.title + ' (' + service.form_number + ')</td><td>' + rupees(service.fee_cents) + '</td></tr></table>' +
      '<p class="hint" style="margin-top:10px;">' + (session.selectedSlot ? ('Slot: <strong>' + session.selectedSlot.date + ' · ' + session.selectedSlot.time + '</strong>') : 'Waiting for you to choose an RTO visit date and time…') + '</p>';
  }
  else if(phase === 'payment'){
    el.innerHTML =
      '<table class="fee-table" style="margin:0;"><tr><td>' + service.title + ' (' + service.form_number + ')</td><td>' + rupees(service.fee_cents) + '</td></tr></table>' +
      (session.selectedSlot ? '<p class="hint" style="margin-top:10px;">Slot: <strong>' + session.selectedSlot.date + ' · ' + session.selectedSlot.time + '</strong></p>' : '') +
      '<p class="hint" style="margin-top:10px;">Waiting for payment…</p>';
  }
  else if(phase === 'track'){
    el.innerHTML =
      '<p class="hint" style="margin:0;">Application submitted.</p>' +
      '<p class="rec-id" style="margin-top:6px;">Reference: ' + (session.referenceCode || '—') + '</p>';
  }
}

function resetVoiceScreen(){
  setVoiceCaption('Tap "Start conversation" and allow microphone access to begin.');
  setVoiceUserCaption('');
  document.getElementById('voice-mic-dot').classList.remove('live');
  document.getElementById('voice-toggle-btn').hidden = false;
  document.getElementById('voice-toggle-btn').disabled = false;
  document.getElementById('voice-view-application').hidden = true;
  var input = document.getElementById('voice-text-input');
  input.disabled = true;
  input.value = '';
  voiceCaptionBuffer = '';
  document.getElementById('voice-detail').innerHTML = '<p class="hint" style="margin:0;">Details will appear here once you start.</p>';
  renderVoiceProgress('details');
}

function stopVoiceConnection(){
  if(voicePC){ try{ voicePC.close(); } catch(e){} voicePC = null; }
  if(voiceStream){ voiceStream.getTracks().forEach(function(t){ t.stop(); }); voiceStream = null; }
  voiceDC = null;
  document.getElementById('voice-mic-dot').classList.remove('live');
}

function endVoiceRenewal(){
  stopVoiceConnection();
  showScreen('screen-dashboard');
}

async function handleVoiceToolCall(name, args, callId){
  var result = {};
  try{
    if(name === 'start_application'){
      await createApplication('renew');
      result = { ok: true, referenceCode: session.referenceCode };
      renderVoiceProgress('documents');
    }
    else if(name === 'confirm_documents'){
      result = { ok: true };
      renderVoiceProgress(session.service.requires_slot ? 'slot' : 'payment');
    }
    else if(name === 'select_slot'){
      session.selectedSlot = { date: args.date, time: args.time };
      result = { ok: true };
      renderVoiceProgress('payment');
    }
    else if(name === 'make_payment'){
      var payment = await processPayment(args.method, 1200);
      result = { ok: true, status: payment.status };
    }
    else if(name === 'finish'){
      if(!session.applicationId){
        result = { error: 'No application has been started yet — call start_application first.' };
      } else {
        renderVoiceProgress('track');
        document.getElementById('voice-view-application').hidden = false;
        result = { ok: true, referenceCode: session.referenceCode };
      }
    }
    else {
      result = { error: 'Unknown tool: ' + name };
    }
  } catch(err){
    result = { error: err.message };
  }
  if(voiceDC && voiceDC.readyState === 'open'){
    voiceDC.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } }));
    voiceDC.send(JSON.stringify({ type: 'response.create' }));
  }
}

function handleVoiceEvent(evt){
  if(evt.type === 'response.output_audio_transcript.delta'){
    if(voiceCaptionBuffer === ''){
      var caption = document.getElementById('voice-caption');
      caption.classList.remove('voice-caption-fade');
      void caption.offsetWidth;
      caption.classList.add('voice-caption-fade');
    }
    voiceCaptionBuffer += evt.delta;
    scheduleVoiceCaptionUpdate();
  }
  else if(evt.type === 'response.done'){
    voiceCaptionBuffer = '';
    var output = (evt.response && evt.response.output) || [];
    output.forEach(function(item){
      if(item.type === 'function_call'){
        var args = {};
        try{ args = JSON.parse(item.arguments || '{}'); } catch(e){}
        handleVoiceToolCall(item.name, args, item.call_id);
      }
    });
  }
  else if(evt.type === 'conversation.item.input_audio_transcription.completed' && evt.transcript){
    setVoiceUserCaption(evt.transcript);
  }
}

async function startVoiceRenewal(){
  var btn = document.getElementById('voice-toggle-btn');
  btn.disabled = true;
  setVoiceCaption('Connecting…');

  try{
    var data = await api('/api/applications/service/renew');
    session.service = data.service;
    var form1a = computeForm1a(session.service, session.citizen);

    var voiceSession = await api('/api/realtime/session', { method: 'POST', body: {
      citizenName: session.citizen.name,
      dob: session.citizen.dob,
      vehicleClasses: session.citizen.vehicle_classes,
      rto: session.citizen.state + ' · ' + session.citizen.rto,
      formNumber: session.service.form_number,
      feeRupees: Math.round(session.service.fee_cents / 100),
      requiresSlot: session.service.requires_slot,
      form1a: form1a,
    }});

    voicePC = new RTCPeerConnection();
    var audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    voicePC.ontrack = function(e){ audioEl.srcObject = e.streams[0]; };

    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voicePC.addTrack(voiceStream.getTracks()[0]);

    voiceDC = voicePC.createDataChannel('oai-events');
    voiceDC.addEventListener('open', function(){
      setVoiceCaption('Connected — say hello!');
      document.getElementById('voice-mic-dot').classList.add('live');
      btn.hidden = true;
      document.getElementById('voice-text-input').disabled = false;
      renderVoiceProgress('details');
    });
    voiceDC.addEventListener('message', function(e){
      try{ handleVoiceEvent(JSON.parse(e.data)); } catch(err){}
    });
    voiceDC.addEventListener('close', function(){
      setVoiceCaption('Disconnected.');
      document.getElementById('voice-mic-dot').classList.remove('live');
    });

    var offer = await voicePC.createOffer();
    await voicePC.setLocalDescription(offer);

    var sdpRes = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: 'Bearer ' + voiceSession.value,
        'Content-Type': 'application/sdp',
      },
    });
    if(!sdpRes.ok) throw new Error('Could not connect to the voice assistant.');
    var answerSdp = await sdpRes.text();
    await voicePC.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch(err){
    setVoiceCaption(err.message || 'Could not start the voice assistant.');
    btn.disabled = false;
    stopVoiceConnection();
  }
}

async function handleAction(action, el){
  try{
    if(action === 'autofill-demo'){
      document.getElementById('mobile-input').value = '9000000001';
      document.getElementById('mobile-error').hidden = true;
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
    else if(action === 'intake-next'){ intakeSubstep = Math.min(3, intakeSubstep + 1); renderIntakeSubsteps(); }
    else if(action === 'intake-back'){ intakeSubstep = Math.max(1, intakeSubstep - 1); renderIntakeSubsteps(); }
    else if(action === 'start-voice-renew'){
      if(!session.citizen){ showScreen('screen-login'); return; }
      resetVoiceScreen();
      showScreen('screen-voice-renew');
    }
    else if(action === 'voice-start'){ await startVoiceRenewal(); }
    else if(action === 'voice-end'){ endVoiceRenewal(); }
    else if(action === 'goto-pay'){
      if(session.service.requires_slot && !session.selectedSlot){
        document.getElementById('cal-slot-summary').textContent = 'Please pick a date and time above to continue.';
        return;
      }
      renderPayScreen();
      showScreen('screen-pay');
    }
    else if(action === 'pay-now'){ await runPayment(false); }
    else if(action === 'pay-delay-demo'){ await runPayment(true); }
    else if(action === 'goto-track'){
      stopVoiceConnection();
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
    else if(action === 'goto-login'){ showScreen('screen-login'); }
    else if(action === 'goto-home'){ showScreen('screen-home'); }
    else if(action === 'logout'){
      localStorage.removeItem('setu_citizen');
      session.citizen = null; session.applicationId = null; session.referenceCode = null; session.service = null; session.application = null;
      showScreen('screen-home');
    }
    else if(action === 'escalate-demo'){ await escalateDemo(); }
    else if(action === 'add-calendar'){ downloadIcs(); }
    else if(action === 'print-receipt'){ window.print(); }
    else if(action === 'toggle-lang'){ document.body.classList.toggle('lang-hi'); }
    else if(action === 'font-inc'){ fontScale = Math.min(130, fontScale+10); applyFont(); }
    else if(action === 'font-dec'){ fontScale = Math.max(90, fontScale-10); applyFont(); }
    else if(action === 'font-reset'){ fontScale = 100; applyFont(); }
  } catch(err){
    if(action === 'verify-otp'){ document.getElementById('otp-error').hidden = false; document.getElementById('otp-error').textContent = err.message; }
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

  document.getElementById('voice-text-input').addEventListener('keydown', function(e){
    if(e.key !== 'Enter') return;
    var text = e.target.value.trim();
    if(!text || !voiceDC || voiceDC.readyState !== 'open') return;
    setVoiceUserCaption(text);
    voiceDC.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: text }] } }));
    voiceDC.send(JSON.stringify({ type: 'response.create' }));
    e.target.value = '';
  });

  var saved = localStorage.getItem('setu_citizen');
  if(saved){
    session.citizen = JSON.parse(saved);
    syncAndShowDashboard();
  }
});
