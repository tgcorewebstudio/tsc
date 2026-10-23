(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const when = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/Phoenix', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const to12h = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
  const dateLabel = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  let key = sessionStorage.getItem('tsc-admin-key') || '';
  let tab = 'orders';
  let timer;

  async function api(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Admin-Key': key } });
    if (res.status === 401) { logout(); throw new Error('unauthorized'); }
    return res.json();
  }

  // Next status buttons per item type
  const FLOW = {
    orders: { new: [['preparing', 'Start making', 'btn-primary'], ['cancelled', 'Cancel', 'btn-outline']],
              preparing: [['ready', 'Mark ready', 'btn-primary']],
              ready: [['completed', 'Picked up', 'btn-dark']] },
    reservations: { confirmed: [['seated', 'Seated', 'btn-primary'], ['no-show', 'No-show', 'btn-outline'], ['cancelled', 'Cancel', 'btn-outline']],
                    seated: [['completed', 'Done', 'btn-dark']] },
    messages: { new: [['handled', 'Mark handled', 'btn-primary']] },
  };
  const buttons = (type, row) => (FLOW[type][row.status] || [])
    .map(([s, label, cls]) => `<button class="btn ${cls}" type="button" data-set="${s}" data-id="${row.id}">${label}</button>`).join('');

  const RENDER = {
    orders: (o) => `
      <article class="row ${o.status === 'new' ? 'is-new' : ''}">
        <div>
          <h3>#${esc(o.code)} · ${esc(o.name)} <span class="status s-${o.status}">${o.status}</span>
            ${o.payment_status === 'paid' ? '<span class="status s-paid">Paid online</span>' : ''}
            ${o.payment_status === 'refunded' ? '<span class="status s-cancelled">Refunded</span>' : ''}</h3>
          <p class="meta">${o.order_type === 'curbside' ? `Curbside — ${esc(o.car)}` : 'In-café pickup'} · ${esc(o.pickup_time)} · placed ${when(o.created_at)}</p>
          <p class="meta"><a href="tel:${esc(o.phone)}">${esc(o.phone)}</a>${o.email ? ` · ${esc(o.email)}` : ''}</p>
          <ul>${o.items.map((l) => `<li>${l.qty} × ${esc(l.name)}</li>`).join('')}</ul>
          ${o.notes ? `<p class="msg"><strong>Notes:</strong> ${esc(o.notes)}</p>` : ''}
          <p style="margin-top:6px"><strong>${money(o.total)}</strong> ${PAY_LABEL[o.payment_status] || 'due at pickup'}</p>
        </div>
        <div class="actions">${buttons('orders', o)}</div>
      </article>`,
    reservations: (r) => `
      <article class="row ${r.status === 'confirmed' ? 'is-new' : ''}">
        <div>
          <h3>${dateLabel(r.date)} · ${to12h(r.time)} · ${r.party} guests <span class="status s-${r.status}">${r.status}</span></h3>
          <p class="meta">${esc(r.name)} · <a href="tel:${esc(r.phone)}">${esc(r.phone)}</a>${r.email ? ` · ${esc(r.email)}` : ''} · #${esc(r.code)}</p>
          ${r.notes ? `<p class="msg"><strong>Notes:</strong> ${esc(r.notes)}</p>` : ''}
        </div>
        <div class="actions">${buttons('reservations', r)}</div>
      </article>`,
    messages: (m) => `
      <article class="row ${m.status === 'new' ? 'is-new' : ''}">
        <div>
          <h3>${esc(m.topic)} · ${esc(m.name)} <span class="status s-${m.status}">${m.status}</span></h3>
          <p class="meta">${when(m.created_at)}${m.email ? ` · <a href="mailto:${esc(m.email)}?subject=${encodeURIComponent('Re: ' + m.topic)}">${esc(m.email)}</a>` : ''}${m.phone ? ` · <a href="tel:${esc(m.phone)}">${esc(m.phone)}</a>` : ''}</p>
          <p class="msg">${esc(m.message)}</p>
        </div>
        <div class="actions">${buttons('messages', m)}</div>
      </article>`,
  };
  const PAY_LABEL = { paid: 'paid online — nothing to collect', refunded: 'refunded to card', at_pickup: 'due at pickup' };
  const EMPTY = { orders: 'No orders yet.', reservations: 'No upcoming reservations.', messages: 'No messages yet.' };

  async function refresh() {
    try {
      const [summary, rows] = await Promise.all([api('/api/admin/summary'), api(`/api/admin/${tab}`)]);
      Object.entries(summary).forEach(([k, v]) => {
        const el = $(`[data-stat="${k}"]`);
        if (el) el.textContent = k === 'today_sales' ? money(v) : v;
      });
      $('#panel').innerHTML = rows.length ? rows.map(RENDER[tab]).join('') : `<p class="empty">${EMPTY[tab]}</p>`;
      $('[data-updated]').textContent = `Last updated ${new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}.`;
    } catch (_) { /* handled in api */ }
  }

  function showDash() {
    $('#login').hidden = true;
    $('#dash').hidden = false;
    $('#logout').hidden = false;
    refresh();
    clearInterval(timer);
    timer = setInterval(refresh, 15000);
  }
  function logout() {
    key = '';
    sessionStorage.removeItem('tsc-admin-key');
    clearInterval(timer);
    $('#dash').hidden = true;
    $('#logout').hidden = true;
    $('#login').hidden = false;
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    key = $('#key').value.trim();
    const res = await fetch('/api/admin/login', { method: 'POST', headers: { 'X-Admin-Key': key } });
    if (res.ok) {
      sessionStorage.setItem('tsc-admin-key', key);
      showDash();
    } else {
      const fe = $('[data-form-error]');
      fe.textContent = 'That key didn’t work. Check data/admin_key.txt on the server.';
      fe.hidden = false;
      $('#key').setAttribute('aria-invalid', 'true');
      $('#key').focus();
    }
  });
  $('#logout').addEventListener('click', logout);

  $$('.tab').forEach((t) => t.addEventListener('click', () => {
    tab = t.dataset.tab;
    $$('.tab').forEach((x) => x.setAttribute('aria-selected', String(x === t)));
    refresh();
  }));

  $('#panel').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-set]');
    if (!b) return;
    if (tab === 'orders' && b.dataset.set === 'cancelled' && b.closest('.row').querySelector('.s-paid')
        && !confirm('This order was paid online. Cancelling it refunds the full amount to the customer’s card. Continue?')) return;
    b.disabled = true;
    const res = await api(`/api/admin/${tab}/${b.dataset.id}`, { method: 'PATCH', body: JSON.stringify({ status: b.dataset.set }) });
    if (res.error) alert(res.error);
    refresh();
  });

  if (key) showDash();
})();
