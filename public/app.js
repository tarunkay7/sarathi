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
  form1a.innerHTML = '<span class="tick">✓</span><span>Medical certificate (Form 1A) — <strong id="form1a-reason">required</strong></span><a class="form-link" href="/forms/FORM-1A.pdf" target="_blank" rel="noopener">Open Form 1A</a>';
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

function getAvailableSlotDates(){
  return CAL_AVAILABLE_DAYS.map(function(day){ return formatDate(new Date(CAL_YEAR, CAL_MONTH, day).toISOString()); });
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
    var appointment = session.selectedSlot || { date: 'Tue 02 Sep 2026', time: '10:00 AM' };
    document.getElementById('appointment-location').textContent = 'RTO ' + session.citizen.rto + ', ' + session.citizen.state;
    document.getElementById('appointment-datetime').textContent = appointment.date + ' · ' + appointment.time;
    document.getElementById('appointment-carry').textContent = 'Acknowledgement slip, existing driving licence' + (form1a.required ? ', and completed Form 1A medical certificate' : '');
  }
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
var wakeRecognition = null;
var wakeWordArmed = false;

var VOICE_INNER_ORDER = ['details', 'documents', 'slot'];

// Caption text streams in over the data channel well ahead of the audio it
// describes (text deltas arrive as JSON; audio arrives as a jittered RTP
// track), so we pace the reveal to roughly speaking speed instead of
// dumping the whole buffer the instant it lands.
var VOICE_CAPTION_CPS = 15;
var voiceCaptionRevealed = '';
var voiceCaptionRevealTimer = null;

// Response state machine: guards against two responses (and their audio)
// overlapping, and lets us insert a natural breath before the assistant
// starts its next turn instead of firing back-to-back.
var voiceResponseActive = false;
var voiceResponseQueued = false;
var voiceResponseTimer = null;

function setVoiceCaption(text){
  var caption = document.getElementById('voice-caption');
  caption.textContent = text;
  // Keep new words in view without allowing the growing transcript to affect
  // the card's dimensions.
  caption.scrollTop = caption.scrollHeight;
}

function setVoiceStatus(text){
  document.getElementById('voice-status-text').textContent = text;
}

function stopWakeWordListener(){
  wakeWordArmed = false;
  if(wakeRecognition){
    wakeRecognition.onend = null;
    try{ wakeRecognition.stop(); } catch(e){}
    wakeRecognition = null;
  }
}

function enableVoiceWakeWord(){
  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var btn = document.getElementById('voice-toggle-btn');
  if(!Recognition){
    setVoiceCaption('Wake-word activation needs a current Chrome or Edge browser.');
    setVoiceStatus('Voice activation unavailable');
    return;
  }

  stopWakeWordListener();
  wakeWordArmed = true;
  wakeRecognition = new Recognition();
  wakeRecognition.continuous = true;
  wakeRecognition.interimResults = true;
  wakeRecognition.lang = 'en-IN';

  wakeRecognition.onstart = function(){
    setVoiceCaption('Listening for “Hello”…');
    setVoiceStatus('Say “Hello” to start');
    btn.hidden = true;
  };
  wakeRecognition.onresult = function(event){
    var latest = event.results[event.results.length - 1];
    var heard = latest && latest[0] ? latest[0].transcript.trim() : '';
    if(!heard){ return; }
    setVoiceUserCaption(heard);
    if(/\bhello\b/i.test(heard)){
      wakeWordArmed = false;
      setVoiceCaption('Hello heard. Connecting…');
      setVoiceStatus('Connecting to Setu');
      try{ wakeRecognition.stop(); } catch(e){}
      wakeRecognition = null;
      setTimeout(function(){ startVoiceRenewal(); }, 120);
    }
  };
  wakeRecognition.onerror = function(event){
    if(event.error === 'aborted' || event.error === 'no-speech'){ return; }
    wakeWordArmed = false;
    wakeRecognition = null;
    setVoiceCaption('Microphone access is needed to listen for “Hello”.');
    setVoiceStatus('Microphone unavailable');
    btn.hidden = false;
  };
  wakeRecognition.onend = function(){
    if(wakeWordArmed && !voicePC){
      setTimeout(function(){
        if(wakeWordArmed && wakeRecognition){
          try{ wakeRecognition.start(); } catch(e){}
        }
      }, 150);
    }
  };
  try{ wakeRecognition.start(); }
  catch(err){
    wakeWordArmed = false;
    wakeRecognition = null;
    setVoiceCaption('Microphone access is needed to listen for “Hello”.');
    setVoiceStatus('Microphone unavailable');
  }
}

function startVoiceCaptionReveal(){
  if(voiceCaptionRevealTimer) return;
  voiceCaptionRevealTimer = setInterval(function(){
    if(voiceCaptionRevealed.length < voiceCaptionBuffer.length){
      var lag = voiceCaptionBuffer.length - voiceCaptionRevealed.length;
      var step = lag > 50 ? Math.ceil(lag / 8) : 1;
      voiceCaptionRevealed = voiceCaptionBuffer.slice(0, voiceCaptionRevealed.length + step);
      setVoiceCaption(voiceCaptionRevealed);
    } else if(!voiceResponseActive){
      clearInterval(voiceCaptionRevealTimer);
      voiceCaptionRevealTimer = null;
    }
  }, 1000 / VOICE_CAPTION_CPS);
}

function sendVoiceEvent(payload){
  if(voiceDC && voiceDC.readyState === 'open'){ voiceDC.send(JSON.stringify(payload)); }
}

// Waits for the caption to finish revealing (a proxy for the audio having
// finished playing) plus a short fixed pause, then starts the next turn.
// If a turn is already in flight, defers until it reports done.
function requestVoiceResponse(minDelayMs){
  clearTimeout(voiceResponseTimer);
  if(voiceResponseActive){
    voiceResponseQueued = true;
    return;
  }
  var wait = function(){
    if(voiceCaptionRevealed.length < voiceCaptionBuffer.length){
      voiceResponseTimer = setTimeout(wait, 80);
      return;
    }
    voiceResponseTimer = setTimeout(function(){ sendVoiceEvent({ type: 'response.create' }); }, minDelayMs || 0);
  };
  wait();
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

function vcard(opts){
  var state = opts.state || '';
  var delay = ((opts.delay || 0)).toFixed(2);
  var iconHtml = '';
  if(opts.icon === 'spinner'){
    iconHtml = '<span class="vcard-icon vcard-icon-spinner"><span class="vcard-spinner"></span></span>';
  } else if(opts.icon){
    iconHtml = '<span class="vcard-icon">' + opts.icon + '</span>';
  }
  return '<div class="vcard ' + state + '" style="animation-delay:' + delay + 's">' +
    iconHtml +
    '<div class="vcard-body">' +
      '<span class="vcard-label">' + opts.label + '</span>' +
      '<span class="vcard-value">' + opts.value + '</span>' +
      (opts.sub ? '<span class="vcard-sub">' + opts.sub + '</span>' : '') +
    '</div>' +
  '</div>';
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
    var rows = [
      { label: 'Applicant', value: citizen.name },
      { label: 'State / RTO', value: citizen.state + ' · ' + citizen.rto },
      { label: 'DL number', value: citizen.dl_number || '—' },
      { label: 'Date of birth', value: citizen.dob ? formatDate(citizen.dob) : '—' },
      { label: 'Licence class', value: citizen.vehicle_classes || '—' },
    ];
    el.innerHTML = '<div class="vcard-list">' + rows.map(function(r, i){
      return vcard({ label: r.label, value: r.value, delay: i * 0.07 });
    }).join('') + '</div>';
  }
  else if(phase === 'documents'){
    var form1a = computeForm1a(service, citizen);
    var rows = service.checklist.map(function(item){
      return { icon: '✓', label: 'Document ready', value: item.label, sub: item.badge, state: 'confirmed' };
    });
    if(form1a.required){
      rows.push({ icon: '✓', label: 'Medical certificate needed', value: 'Form 1A <a class="form-link" href="/forms/FORM-1A.pdf" target="_blank" rel="noopener">Open form</a>', sub: form1a.reason, state: 'flag' });
    }
    el.innerHTML = '<div class="vcard-list">' + rows.map(function(r, i){
      return vcard({ icon: r.icon, label: r.label, value: r.value, sub: r.sub, state: r.state, delay: i * 0.07 });
    }).join('') + '</div>';
  }
  else if(phase === 'slot'){
    var earliestDate = formatDate(new Date(CAL_YEAR, CAL_MONTH, Math.min.apply(null, CAL_AVAILABLE_DAYS)).toISOString());
    var cards = [ vcard({ label: service.title + ' (' + service.form_number + ')', value: rupees(service.fee_cents), delay: 0 }) ];
    if(session.selectedSlot){
      cards.push(vcard({ icon: '✓', label: 'Say "yes" to confirm this RTO visit', value: session.selectedSlot.date + ' · ' + session.selectedSlot.time, state: 'awaiting', delay: 0.07 }));
    } else {
      cards.push(vcard({ label: 'Suggested earliest slot', value: earliestDate, sub: 'Tell Setu your preferred date and time', state: 'pending', delay: 0.07 }));
    }
    el.innerHTML = '<div class="vcard-list">' + cards.join('') + '</div>';
  }
  else if(phase === 'payment'){
    var cards = [ vcard({ label: service.title + ' (' + service.form_number + ')', value: rupees(service.fee_cents), delay: 0 }) ];
    if(session.selectedSlot){
      cards.push(vcard({ icon: '✓', label: 'RTO visit confirmed', value: session.selectedSlot.date + ' · ' + session.selectedSlot.time, state: 'confirmed', delay: 0.07 }));
    }
    if(session.paymentDone){
      cards.push(vcard({ icon: '✓', label: 'Payment', value: 'Received', sub: session.lastPaymentMethod ? ('via ' + session.lastPaymentMethod) : '', state: 'confirmed just-confirmed', delay: cards.length * 0.07 }));
    } else if(session.paymentProcessing){
      cards.push(vcard({ icon: 'spinner', label: 'Payment', value: 'Processing your ' + (session.lastPaymentMethod || '') + ' payment…', state: 'processing', delay: cards.length * 0.07 }));
    } else {
      cards.push(vcard({ label: 'Payment', value: 'Waiting for confirmation…', state: 'awaiting', delay: cards.length * 0.07 }));
    }
    el.innerHTML = '<div class="vcard-list">' + cards.join('') + '</div>';
  }
  else if(phase === 'track'){
    el.innerHTML = '<div class="vcard-list">' +
      vcard({ icon: '✓', label: 'Application submitted', value: session.referenceCode || '—', state: 'confirmed just-confirmed', delay: 0 }) +
    '</div>';
  }
}

function resetVoiceScreen(){
  stopWakeWordListener();
  session.selectedSlot = null;
  session.paymentDone = false;
  session.paymentProcessing = false;
  setVoiceCaption('Enable your microphone, then say “Hello” to begin.');
  setVoiceUserCaption('');
  setVoiceStatus('Setu is ready');
  document.getElementById('voice-mic-dot').classList.remove('live');
  document.getElementById('voice-toggle-btn').hidden = false;
  document.getElementById('voice-toggle-btn').disabled = false;
  voiceCaptionBuffer = '';
  voiceCaptionRevealed = '';
  if(voiceCaptionRevealTimer){ clearInterval(voiceCaptionRevealTimer); voiceCaptionRevealTimer = null; }
  voiceResponseActive = false;
  voiceResponseQueued = false;
  clearTimeout(voiceResponseTimer);
  document.getElementById('voice-detail').innerHTML = '<p class="hint" style="margin:0;">Details will appear here once you start.</p>';
  document.getElementById('voice-split').classList.add('pre-start');
  var progressPanel = document.getElementById('voice-progress-panel');
  progressPanel.hidden = true;
  progressPanel.classList.remove('voice-reveal');
  renderVoiceProgress('details');
}

function revealVoiceIntake(){
  var split = document.getElementById('voice-split');
  var progressPanel = document.getElementById('voice-progress-panel');
  if(!progressPanel.hidden){ return; }
  split.classList.remove('pre-start');
  progressPanel.hidden = false;
  progressPanel.classList.add('voice-reveal');
  renderVoiceProgress('details');
}

function stopVoiceConnection(){
  stopWakeWordListener();
  sendVoiceEvent({ type: 'response.cancel' });
  clearTimeout(voiceResponseTimer);
  if(voiceCaptionRevealTimer){ clearInterval(voiceCaptionRevealTimer); voiceCaptionRevealTimer = null; }
  voiceResponseActive = false;
  voiceResponseQueued = false;
  voiceCaptionBuffer = '';
  voiceCaptionRevealed = '';
  if(voicePC){ try{ voicePC.close(); } catch(e){} voicePC = null; }
  if(voiceStream){ voiceStream.getTracks().forEach(function(t){ t.stop(); }); voiceStream = null; }
  voiceDC = null;
  document.getElementById('voice-mic-dot').classList.remove('live');
}

function endVoiceRenewal(){
  stopVoiceConnection();
  showScreen('screen-dashboard');
}

// Assistant-initiated hangup (end_call tool): if the renewal actually
// finished, land the citizen on their application status instead of just
// the dashboard.
function endVoiceCallFromAssistant(){
  stopVoiceConnection();
  if(session.applicationId && session.referenceCode){
    openTrack().catch(function(){ showScreen('screen-dashboard'); });
  } else {
    showScreen('screen-dashboard');
  }
}

async function handleVoiceToolCall(name, args, callId){
  var result = {};
  try{
    if(name === 'begin_intake'){
      revealVoiceIntake();
      result = { ok: true };
    }
    else if(name === 'start_application'){
      await createApplication('renew');
      result = { ok: true, referenceCode: session.referenceCode };
      renderVoiceProgress('documents');
    }
    else if(name === 'confirm_documents'){
      result = { ok: true };
      renderVoiceProgress(session.service.requires_slot ? 'slot' : 'payment');
    }
    else if(name === 'select_slot'){
      var availableDates = getAvailableSlotDates();
      if(availableDates.indexOf(args.date) === -1){
        result = { error: 'That date is not available. Available dates are: ' + availableDates.join(', ') + '.' };
      } else if(CAL_TIMES.indexOf(args.time) === -1){
        result = { error: 'That time is not available. Available times are: ' + CAL_TIMES.join(', ') + '.' };
      } else {
        session.selectedSlot = { date: args.date, time: args.time };
        result = { ok: true, note: 'Shown on screen as a proposed card. Ask the citizen to confirm before calling confirm_slot.' };
        renderVoiceProgress('slot');
      }
    }
    else if(name === 'confirm_slot'){
      if(!session.selectedSlot){
        result = { error: 'No slot has been picked yet — call select_slot first.' };
      } else {
        result = { ok: true };
        renderVoiceProgress('payment');
      }
    }
    else if(name === 'make_payment'){
      session.lastPaymentMethod = args.method;
      session.paymentProcessing = true;
      renderVoiceProgress('payment');
      var payment = await processPayment(args.method, 1200);
      session.paymentProcessing = false;
      session.paymentDone = true;
      renderVoiceProgress('payment');
      result = { ok: true, status: payment.status };
    }
    else if(name === 'finish'){
      if(!session.applicationId){
        result = { error: 'No application has been started yet — call start_application first.' };
      } else {
        renderVoiceProgress('track');
        result = { ok: true, referenceCode: session.referenceCode };
      }
    }
    else if(name === 'end_call'){
      result = { ok: true };
    }
    else {
      result = { error: 'Unknown tool: ' + name };
    }
  } catch(err){
    result = { error: err.message };
  }
  sendVoiceEvent({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
  if(name === 'end_call'){
    // Let the goodbye that was just spoken finish playing before hanging up.
    setTimeout(endVoiceCallFromAssistant, 2600);
    return;
  }
  requestVoiceResponse(400);
}

function handleVoiceEvent(evt){
  if(evt.type === 'response.created'){
    voiceResponseActive = true;
    voiceCaptionBuffer = '';
    voiceCaptionRevealed = '';
    setVoiceStatus('Setu is speaking');
  }
  else if(evt.type === 'response.output_audio_transcript.delta'){
    if(voiceCaptionBuffer === ''){
      var caption = document.getElementById('voice-caption');
      caption.classList.remove('voice-caption-fade');
      void caption.offsetWidth;
      caption.classList.add('voice-caption-fade');
    }
    voiceCaptionBuffer += evt.delta;
    startVoiceCaptionReveal();
  }
  else if(evt.type === 'response.done'){
    voiceResponseActive = false;
    setVoiceStatus('Setu is listening');
    var output = (evt.response && evt.response.output) || [];
    var hadToolCall = false;
    output.forEach(function(item){
      if(item.type === 'function_call'){
        hadToolCall = true;
        var args = {};
        try{ args = JSON.parse(item.arguments || '{}'); } catch(e){}
        handleVoiceToolCall(item.name, args, item.call_id);
      }
    });
    if(!hadToolCall && voiceResponseQueued){
      voiceResponseQueued = false;
      requestVoiceResponse(300);
    }
  }
  else if(evt.type === 'conversation.item.input_audio_transcription.completed' && evt.transcript){
    setVoiceUserCaption(evt.transcript);
  }
}

async function startVoiceRenewal(){
  var btn = document.getElementById('voice-toggle-btn');
  stopWakeWordListener();
  btn.disabled = true;
  setVoiceCaption('Connecting…');
  setVoiceStatus('Connecting to Setu');

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
      checklist: session.service.checklist,
      earliestSlotDate: formatDate(new Date(CAL_YEAR, CAL_MONTH, Math.min.apply(null, CAL_AVAILABLE_DAYS)).toISOString()),
      availableDates: getAvailableSlotDates(),
      slotTimes: CAL_TIMES,
    }});

    voicePC = new RTCPeerConnection();
    var audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    voicePC.ontrack = function(e){ audioEl.srcObject = e.streams[0]; };
    voicePC.oniceconnectionstatechange = function(){
      console.log('[voice] ice state:', voicePC.iceConnectionState);
      if(voicePC.iceConnectionState === 'failed' || voicePC.iceConnectionState === 'disconnected'){
        setVoiceCaption('Connection lost (ICE ' + voicePC.iceConnectionState + '). Try again.');
        setVoiceStatus('Connection lost');
      }
    };
    voicePC.onconnectionstatechange = function(){ console.log('[voice] connection state:', voicePC.connectionState); };

    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    voicePC.addTrack(voiceStream.getTracks()[0]);

    voiceDC = voicePC.createDataChannel('oai-events');
    voiceDC.addEventListener('open', function(){
      console.log('[voice] data channel open');
      setVoiceCaption('');
      setVoiceStatus('Setu is listening');
      document.getElementById('voice-mic-dot').classList.add('live');
      btn.hidden = true;
      requestVoiceResponse(0);
    });
    voiceDC.addEventListener('message', function(e){
      try{ handleVoiceEvent(JSON.parse(e.data)); } catch(err){ console.error('[voice] event handling error:', err); }
    });
    voiceDC.addEventListener('error', function(e){ console.error('[voice] data channel error:', e); });
    voiceDC.addEventListener('close', function(){
      console.log('[voice] data channel closed');
      setVoiceCaption('Disconnected.');
      setVoiceStatus('Disconnected');
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
    if(!sdpRes.ok){
      var errText = await sdpRes.text().catch(function(){ return ''; });
      console.error('[voice] SDP exchange failed:', sdpRes.status, errText);
      throw new Error('Could not connect to the voice assistant (HTTP ' + sdpRes.status + ').');
    }
    var answerSdp = await sdpRes.text();
    await voicePC.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  } catch(err){
    console.error('[voice] startVoiceRenewal failed:', err);
    setVoiceCaption(err.message || 'Could not start the voice assistant.');
    setVoiceStatus('Could not connect');
    btn.hidden = false;
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
    else if(action === 'voice-enable'){ enableVoiceWakeWord(); }
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

  var saved = localStorage.getItem('setu_citizen');
  if(saved){
    session.citizen = JSON.parse(saved);
    syncAndShowDashboard();
  }
});
