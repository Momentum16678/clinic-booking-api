// Ìlera Clinic booking page: plain JavaScript, no build step.
// Calls /web/* on the same server, so the API key never reaches the browser.

const $ = (selector, root = document) => root.querySelector(selector);

const els = {
  doctorOptions: $('#doctor-options'),
  days: $('#days'),
  times: $('#times'),
  tzNote: $('#tz-note'),
  panel: $('#panel'),
  findForm: $('#find-form'),
  findInput: $('#find-input'),
  formTemplate: $('#form-template'),
};

const state = {
  allSlots: [], // every slot, including past ones (for showing an old booking)
  doctor: 'all',
  day: null,
  selected: null, // the slot being booked
  pending: null, // { fingerprint, key } — reused if the same request is retried
  booking: null,
  notice: '',
};

const fmt = {
  weekday: new Intl.DateTimeFormat('en-GB', { weekday: 'short' }),
  dayMonth: new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }),
  long: new Intl.DateTimeFormat('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }),
  time: new Intl.DateTimeFormat('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true }),
};

// Data

async function request(method, path, body, headers = {}) {
  const res = await fetch(`/web${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }
  return { status: res.status, ok: res.ok, data, retryAfter: res.headers.get('Retry-After') };
}

async function loadSlots() {
  try {
    const res = await request('GET', '/slots');
    if (!res.ok) throw new Error(res.data?.error || `HTTP ${res.status}`);
    state.allSlots = res.data.slots.map((s) => ({ ...s, startAt: new Date(s.start), endAt: new Date(s.end) }));
    if (state.selected) {
      const fresh = state.allSlots.find((s) => s.id === state.selected.id);
      if (!fresh || !fresh.available) state.selected = null;
      else state.selected = fresh;
    }
    renderPicker();
  } catch {
    els.days.replaceChildren();
    const retry = el('button', { type: 'button', className: 'btn btn-quiet retry' }, 'Try again');
    retry.addEventListener('click', () => {
      retry.disabled = true;
      retry.textContent = 'Loading…';
      loadSlots();
    });
    els.times.replaceChildren(
      el('div', { className: 'placeholder' }, el('p', {}, "Couldn't load appointment times."), retry)
    );
  }
}

const upcoming = () => state.allSlots.filter((s) => s.startAt.getTime() > Date.now());
const slotById = (id) => state.allSlots.find((s) => s.id === id);
const localDay = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Picker (left side)

function renderPicker() {
  const slots = upcoming();
  renderDoctors(slots);

  const visible = slots.filter((s) => state.doctor === 'all' || s.provider === state.doctor);
  const days = [...new Set(visible.map((s) => localDay(s.startAt)))];
  if (!days.includes(state.day)) {
    state.day = days.find((d) => visible.some((s) => localDay(s.startAt) === d && s.available)) ?? days[0] ?? null;
  }
  renderDays(visible, days);
  renderTimes(visible.filter((s) => localDay(s.startAt) === state.day));
  renderTzNote();
}

function renderDoctors(slots) {
  const doctors = [...new Set(slots.map((s) => s.provider))].sort();
  if (state.doctor !== 'all' && !doctors.includes(state.doctor)) state.doctor = 'all';
  els.doctorOptions.replaceChildren(
    ...['all', ...doctors].map((doctor) => {
      const input = el('input', { type: 'radio', name: 'doctor', value: doctor, checked: state.doctor === doctor });
      input.addEventListener('change', () => {
        state.doctor = doctor;
        renderPicker();
      });
      return el('label', {}, input, el('span', {}, doctor === 'all' ? 'Any doctor' : doctor));
    })
  );
}

function renderDays(visible, days) {
  els.days.replaceChildren(
    ...days.map((day) => {
      const daySlots = visible.filter((s) => localDay(s.startAt) === day);
      const free = daySlots.filter((s) => s.available).length;
      const date = daySlots[0].startAt;
      const button = el(
        'button',
        {
          type: 'button',
          className: 'day',
          'aria-pressed': String(day === state.day),
          'aria-label': `${fmt.long.format(date)}, ${free ? `${free} free` : 'fully booked'}`,
        },
        el('span', { className: 'day-weekday' }, fmt.weekday.format(date)),
        el('span', { className: 'day-date' }, fmt.dayMonth.format(date)),
        el('span', { className: free ? 'day-free' : 'day-free none' }, free ? `${free} free` : 'Full')
      );
      button.addEventListener('click', () => {
        state.day = day;
        renderPicker();
      });
      return button;
    })
  );
  const selected = $('.day[aria-pressed="true"]', els.days);
  selected?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderTimes(daySlots) {
  if (state.allSlots.length === 0 || daySlots.length === 0) {
    els.times.replaceChildren(
      el('p', { className: 'placeholder' }, 'There are no upcoming appointment times right now. Check back soon.')
    );
    return;
  }
  const byDoctor = new Map();
  for (const slot of daySlots) {
    if (!byDoctor.has(slot.provider)) byDoctor.set(slot.provider, []);
    byDoctor.get(slot.provider).push(slot);
  }
  els.times.replaceChildren(
    ...[...byDoctor].map(([doctor, slots]) =>
      el(
        'div',
        { className: 'doctor-row' },
        el('p', { className: 'doctor-name' }, doctor),
        el('div', { className: 'slot-grid' }, ...slots.map(slotButton))
      )
    )
  );
}

function slotButton(slot) {
  const time = fmt.time.format(slot.startAt);
  const button = el(
    'button',
    {
      type: 'button',
      className: 'slot',
      disabled: !slot.available,
      'aria-pressed': String(state.selected?.id === slot.id),
      'aria-label': `${time} with ${slot.provider}${slot.available ? '' : ', taken'}`,
    },
    el('span', { className: 'slot-time' }, time),
    slot.available ? null : el('span', { className: 'slot-taken' }, 'Taken')
  );
  button.addEventListener('click', () => chooseSlot(slot));
  return button;
}

function renderTzNote() {
  const zone = new Intl.DateTimeFormat('en-GB', { timeZoneName: 'long' })
    .formatToParts(new Date())
    .find((p) => p.type === 'timeZoneName')?.value;
  els.tzNote.textContent = zone ? `Times are shown in your time zone (${zone}).` : '';
}

function chooseSlot(slot) {
  state.selected = slot;
  state.booking = null;
  state.notice = '';
  renderPicker();
  renderForm();
  if (window.matchMedia('(max-width: 860px)').matches) {
    els.panel.scrollIntoView({ behavior: prefersMotion() ? 'smooth' : 'auto', block: 'start' });
  }
  $('#name', els.panel)?.focus({ preventScroll: true });
}

// Panel (right side)

function renderEmpty() {
  const children = [];
  if (state.notice) children.push(el('p', { className: 'notice', role: 'alert' }, state.notice));
  children.push(
    el(
      'div',
      { className: 'panel-empty' },
      el('p', { className: 'panel-empty-title' }, 'No time picked yet'),
      el('p', {}, 'Choose a time to book it.')
    )
  );
  els.panel.replaceChildren(...children);
}

function renderForm(previous = {}) {
  const slot = state.selected;
  const form = els.formTemplate.content.firstElementChild.cloneNode(true);
  $('.chosen', form).replaceChildren(
    el('strong', {}, `${fmt.long.format(slot.startAt)}, ${fmt.time.format(slot.startAt)}`),
    `with ${slot.provider}`
  );
  if (previous.name) $('#name', form).value = previous.name;
  if (previous.email) $('#email', form).value = previous.email;
  form.addEventListener('submit', submitBooking);
  $('.change-time', form).addEventListener('click', () => {
    state.selected = null;
    renderPicker();
    renderEmpty();
    $('.slot:not(:disabled)', els.times)?.focus();
  });
  els.panel.replaceChildren(form);
}

async function submitBooking(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const nameInput = $('#name', form);
  const emailInput = $('#email', form);
  const button = $('.btn-primary', form);
  const name = nameInput.value.trim();
  const email = emailInput.value.trim();

  nameInput.removeAttribute('aria-invalid');
  emailInput.removeAttribute('aria-invalid');
  if (!name) return showFormError(form, 'Enter your full name.', nameInput);
  if (!emailInput.checkValidity() || !email) return showFormError(form, 'Enter an email address like name@example.com.', emailInput);

  const body = { slot_id: state.selected.id, name, email };
  // Level 4, browser side: one Idempotency-Key per booking request, reused on a
  // double-click or retry so the server returns the first booking.
  const fingerprint = JSON.stringify(body);
  if (state.pending?.fingerprint !== fingerprint) state.pending = { fingerprint, key: crypto.randomUUID() };

  button.disabled = true;
  button.textContent = 'Booking…';
  let res;
  try {
    res = await request('POST', '/bookings', body, { 'Idempotency-Key': state.pending.key });
  } catch {
    button.disabled = false;
    button.textContent = 'Try again';
    return showFormError(form, "Couldn't reach the clinic. Check your connection and try again. You won't be booked twice.");
  }
  state.pending = null; // we got an answer, so this request is settled

  if (res.status === 201) {
    state.booking = res.data;
    state.selected = null;
    showBooking({ arrive: true });
    loadSlots();
    return;
  }

  button.disabled = false;
  button.textContent = 'Book this appointment';
  if (res.status === 409 || res.status === 404 || (res.status === 400 && /started/.test(res.data?.error))) {
    state.selected = null;
    state.notice =
      res.status === 409 ? 'Someone else just booked that time. Please pick another.' : 'That time is no longer available. Please pick another.';
    renderEmpty();
    loadSlots();
    return;
  }
  if (res.status === 429) {
    const seconds = Number(res.retryAfter) || 60;
    return showFormError(form, `Too many booking attempts with this email. Try again in ${seconds} second${seconds === 1 ? '' : 's'}.`);
  }
  if (res.status === 400) {
    const field = /email/.test(res.data?.error) ? emailInput : /name/.test(res.data?.error) ? nameInput : null;
    return showFormError(form, sentence(res.data?.error || 'Check your details and try again.'), field);
  }
  showFormError(form, "Something went wrong on our side and the booking wasn't made. Please try again.");
}

function showFormError(form, message, field) {
  const box = $('.form-error', form);
  box.textContent = message;
  box.hidden = false;
  if (field) {
    field.setAttribute('aria-invalid', 'true');
    field.focus();
  }
}

// The appointment card

function showBooking({ arrive = false } = {}) {
  const b = state.booking;
  const slot = slotById(b.slot_id);
  const cancelled = b.status === 'cancelled';
  history.replaceState(null, '', `?booking=${encodeURIComponent(b.id)}`);

  const when = slot
    ? [fmt.long.format(slot.startAt), el('strong', {}, `${fmt.time.format(slot.startAt)} – ${fmt.time.format(slot.endAt)}`)]
    : [`Slot ${b.slot_id}`];

  const copyButton = el('button', { type: 'button', className: 'btn btn-quiet copy' }, 'Copy');
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(b.id);
      copyButton.textContent = 'Copied';
    } catch {
      copyButton.textContent = 'Select and copy';
    }
  });

  const actions = el('div', { className: 'ticket-actions' });
  const another = el('button', { type: 'button', className: 'btn btn-quiet' }, 'Book another time');
  another.addEventListener('click', () => {
    state.booking = null;
    history.replaceState(null, '', location.pathname);
    renderEmpty();
    $('.slot:not(:disabled)', els.times)?.focus();
  });

  if (!cancelled) {
    const cancel = el('button', { type: 'button', className: 'btn btn-quiet' }, 'Cancel appointment');
    cancel.addEventListener('click', () => askToCancel(actions, another));
    actions.append(cancel, another);
  } else {
    actions.append(another);
  }

  const card = el(
    'article',
    { className: `ticket${arrive ? ' arrive' : ''}${cancelled ? ' is-cancelled' : ''}`, 'aria-labelledby': 'ticket-title' },
    el(
      'header',
      { className: 'ticket-band' },
      el('p', { className: 'ticket-clinic' }, 'Ìlera Clinic'),
      el('h2', { className: 'ticket-title', id: 'ticket-title', tabIndex: -1 }, cancelled ? 'Appointment cancelled' : 'You’re booked in'),
      el('span', { className: `stamp${cancelled ? ' cancelled' : ''}` }, cancelled ? 'Cancelled' : 'Confirmed')
    ),
    el(
      'div',
      { className: 'ticket-body' },
      el('p', { className: 'ticket-when' }, ...when),
      el(
        'dl',
        { className: 'ticket-details' },
        el('dt', {}, 'Doctor'),
        el('dd', {}, slot?.provider ?? '—'),
        el('dt', {}, 'Patient'),
        el('dd', {}, b.name),
        el('dt', {}, 'Email'),
        el('dd', {}, b.email)
      )
    ),
    el(
      'div',
      { className: 'ticket-stub' },
      el('p', { className: 'ref-label' }, 'Booking reference'),
      el('div', { className: 'ref-row' }, el('p', { className: 'ref' }, b.id), copyButton),
      el(
        'p',
        { className: 'ref-hint' },
        cancelled
          ? 'This time is free again for someone else.'
          : 'Show this at reception. You can use it here to find or cancel your booking.'
      )
    ),
    actions
  );
  els.panel.replaceChildren(card);
  $('#ticket-title', card).focus({ preventScroll: !arrive });
}

function askToCancel(actions, another) {
  const yes = el('button', { type: 'button', className: 'btn btn-danger' }, 'Yes, cancel it');
  const keep = el('button', { type: 'button', className: 'btn btn-quiet' }, 'Keep it');
  keep.addEventListener('click', () => showBooking());
  yes.addEventListener('click', async () => {
    yes.disabled = true;
    yes.textContent = 'Cancelling…';
    try {
      const res = await request('DELETE', `/bookings/${encodeURIComponent(state.booking.id)}`);
      if (res.ok) state.booking = res.data;
      else if (res.status === 409) state.booking = { ...state.booking, status: 'cancelled' };
      else throw new Error();
      showBooking();
      loadSlots();
    } catch {
      actions.replaceChildren(
        el('p', { className: 'notice', role: 'alert' }, "Couldn't cancel just now. Please try again."),
        another
      );
    }
  });
  actions.replaceChildren(el('p', { className: 'confirm-cancel' }, 'Cancel this appointment?'), yes, keep);
  yes.focus();
}

// Find a booking

function normalizeReference(raw) {
  const compact = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^BK/, '');
  if (compact.length !== 12) return raw.trim();
  return `BK-${compact.slice(0, 4)}-${compact.slice(4, 8)}-${compact.slice(8)}`;
}

async function findBooking(reference) {
  const id = normalizeReference(reference);
  els.panel.replaceChildren(el('div', { className: 'panel-empty' }, el('p', {}, 'Looking up your booking…')));
  try {
    const res = await request('GET', `/bookings/${encodeURIComponent(id)}`);
    if (res.ok) {
      state.booking = res.data;
      state.selected = null;
      renderPicker();
      showBooking();
      return;
    }
    state.notice =
      res.status === 404
        ? `No booking found for ${id}. Check the reference and try again.`
        : "Couldn't look up that booking just now. Please try again.";
  } catch {
    state.notice = "Couldn't reach the clinic. Check your connection and try again.";
  }
  history.replaceState(null, '', location.pathname);
  renderEmpty();
}

els.findForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = els.findInput.value.trim();
  if (value) findBooking(value);
  if (window.matchMedia('(max-width: 860px)').matches) els.panel.scrollIntoView({ block: 'start' });
});

// Helpers

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('aria-') || key === 'role') node.setAttribute(key, value);
    else node[key] = value;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined && c !== false));
  return node;
}

function sentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? '' : '.');
}

function prefersMotion() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Start

(async function start() {
  await loadSlots();
  const fromUrl = new URLSearchParams(location.search).get('booking');
  if (fromUrl) {
    els.findInput.value = fromUrl;
    findBooking(fromUrl);
  }
})();
