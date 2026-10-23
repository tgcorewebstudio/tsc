(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const money = (n) => `$${Number(n).toFixed(2)}`;
  const to12h = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  async function api(path, options = {}) {
    const res = await fetch(path, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error('Request failed'), { status: res.status, data });
    return data;
  }

  /* ---------- Toast ---------- */
  const toastEl = $('[data-toast]');
  let toastTimer;
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.hidden = true; }, 3500);
  }

  /* ---------- Mobile nav ---------- */
  const toggle = $('.nav-toggle');
  const links = $('#nav-links');
  const setNav = (open) => {
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    $('use', toggle).setAttribute('href', open ? '#i-x' : '#i-menu');
    links.classList.toggle('open', open);
  };
  toggle.addEventListener('click', () => setNav(toggle.getAttribute('aria-expanded') !== 'true'));
  links.addEventListener('click', (e) => { if (e.target.closest('a')) setNav(false); });

  /* ---------- Marquee ---------- */
  const marquee = $('[data-marquee]');
  const mBtn = $('.marquee-toggle', marquee);
  const setPaused = (paused) => {
    marquee.classList.toggle('paused', paused);
    mBtn.setAttribute('aria-pressed', String(paused));
    mBtn.setAttribute('aria-label', paused ? 'Play scrolling banner' : 'Pause scrolling banner');
    $('use', mBtn).setAttribute('href', paused ? '#i-play' : '#i-pause');
  };
  mBtn.addEventListener('click', () => setPaused(!marquee.classList.contains('paused')));
  if (reduceMotion) setPaused(true);

  /* ---------- Reviews carousel ---------- */
  const track = $('.carousel-track');
  $$('.carousel-controls [data-dir]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = $('.review', track);
      const step = card ? card.getBoundingClientRect().width + 24 : 300;
      track.scrollBy({ left: step * Number(btn.dataset.dir), behavior: reduceMotion ? 'auto' : 'smooth' });
    });
  });
  if (window.innerWidth > 900) track.scrollLeft = (track.scrollWidth - track.clientWidth) / 2;

  /* ---------- Hours (Arizona time, no DST) ---------- */
  try {
    const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', weekday: 'short' }).format(new Date());
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
    $(`.hours tr[data-day="${day}"]`)?.classList.add('today');
  } catch (_) { /* no highlight */ }

  let pickupSlots = [];
  let storeOpen = false;
  let onlinePayment = false;
  async function loadStatus() {
    try {
      const s = await api('/api/status');
      storeOpen = s.open;
      pickupSlots = s.pickup_slots || [];
      if (s.online_payment && !onlinePayment) {
        onlinePayment = true;
        $('[data-pay-note]').replaceChildren($('#pay-online-note').content.cloneNode(true));
        renderCart();
      }
      $('[data-open-status]').textContent = `Tempe · ${s.message}`;
      $('.status-dot').classList.toggle('closed', !s.open);
      const chip = $('[data-open-chip]');
      chip.hidden = false;
      chip.textContent = s.open ? 'Open now' : 'Closed now';
      chip.classList.toggle('closed', !s.open);
      renderPickupOptions(s.message);
    } catch (_) { /* keep static text */ }
  }

  /* ---------- Menu ---------- */
  let MENU = null;
  const ITEMS = {};
  const ICONS = { cup: 'i-cup', bolt: 'i-bolt', bowl: 'i-bowl', wrap: 'i-wrap', flat: 'i-flat', roll: 'i-roll' };

  function thumb(item, icon) {
    if (item.cup) {
      const [a, b, s] = item.cup;
      return `<span class="item-thumb" aria-hidden="true"><svg class="cup-thumb" viewBox="0 0 200 290"><use href="#cup" style="--a:${a};--b:${b};--straw:${s}"/></svg></span>`;
    }
    return `<span class="item-thumb" aria-hidden="true"><svg width="28" height="28"><use href="#${ICONS[icon] || 'i-leaf'}"/></svg></span>`;
  }

  function renderMenu() {
    const root = $('[data-accordion]');
    root.innerHTML = MENU.categories.map((cat, i) => `
      <div class="acc-item">
        <h3 class="acc-heading">
          <button class="acc-trigger" type="button" aria-expanded="${i === 0}" aria-controls="acc-${cat.id}" id="acc-${cat.id}-btn">
            <svg class="acc-icon" width="30" height="30" aria-hidden="true"><use href="#${ICONS[cat.icon] || 'i-leaf'}"/></svg>
            <span>${esc(cat.name)}</span>
            <svg class="acc-chev" width="22" height="22" aria-hidden="true"><use href="#i-chev"/></svg>
          </button>
        </h3>
        <div class="acc-panel" id="acc-${cat.id}" role="region" aria-labelledby="acc-${cat.id}-btn" ${i === 0 ? '' : 'hidden'}>
          <ul class="item-list" role="list">
            ${cat.items.map((item) => `
              <li>
                ${thumb(item, cat.icon)}
                <div>
                  <p class="item-name">${esc(item.name)} ${item.tag ? `<span class="pill">${esc(item.tag)}</span>` : ''}</p>
                  <p class="item-desc">${esc(item.desc)}</p>
                </div>
                <div class="item-buy">
                  <span class="price">${money(item.price)}</span>
                  <button class="add-btn" type="button" data-add="${item.id}" aria-label="Add ${esc(item.name)} to bag">
                    <svg width="16" height="16" aria-hidden="true"><use href="#i-plus"/></svg> Add
                  </button>
                </div>
              </li>`).join('')}
          </ul>
        </div>
      </div>`).join('');

    const triggers = $$('.acc-trigger', root);
    triggers.forEach((btn) => btn.addEventListener('click', () => {
      const willOpen = btn.getAttribute('aria-expanded') !== 'true';
      triggers.forEach((other) => {
        other.setAttribute('aria-expanded', 'false');
        document.getElementById(other.getAttribute('aria-controls')).hidden = true;
      });
      if (willOpen) {
        btn.setAttribute('aria-expanded', 'true');
        document.getElementById(btn.getAttribute('aria-controls')).hidden = false;
      }
    }));

    $$('[data-price-for]').forEach((el) => {
      const item = ITEMS[el.dataset.priceFor];
      if (item) el.textContent = money(item.price);
    });
  }

  async function loadMenu() {
    try {
      MENU = await api('/api/menu');
      MENU.categories.forEach((c) => c.items.forEach((it) => { ITEMS[it.id] = it; }));
      renderMenu();
      renderCart();
    } catch (_) {
      $('[data-menu-status]').innerHTML = 'We couldn’t load the menu. Please refresh, or call <a href="tel:+14804964200">(480) 496-4200</a> to order.';
    }
  }

  /* ---------- Cart state ---------- */
  const CART_KEY = 'tsc-tempe-cart';
  let cart = {};
  try { cart = JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch (_) { cart = {}; }
  const saveCart = () => { try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch (_) { /* private mode */ } };
  const cartEntries = () => Object.entries(cart).filter(([id, q]) => ITEMS[id] && q > 0);
  const cartCount = () => cartEntries().reduce((n, [, q]) => n + q, 0);
  const totals = () => {
    const subtotal = cartEntries().reduce((s, [id, q]) => s + ITEMS[id].price * q, 0);
    const tax = Math.round(subtotal * (MENU?.tax_rate || 0) * 100) / 100;
    return { subtotal, tax, total: subtotal + tax };
  };

  function addToCart(id, btn) {
    if (!ITEMS[id]) return;
    cart[id] = Math.min((cart[id] || 0) + 1, 20);
    saveCart();
    renderCart();
    const badge = $('[data-cart-count]');
    badge.classList.remove('bump'); void badge.offsetWidth; badge.classList.add('bump');
    toast(`${ITEMS[id].name} added to your bag`);
    if (btn && btn.classList.contains('add-btn')) {
      btn.classList.add('added');
      btn.innerHTML = '<svg width="16" height="16" aria-hidden="true"><use href="#i-check"/></svg> Added';
      setTimeout(() => {
        btn.classList.remove('added');
        btn.innerHTML = '<svg width="16" height="16" aria-hidden="true"><use href="#i-plus"/></svg> Add';
      }, 1200);
    }
  }

  document.addEventListener('click', (e) => {
    const add = e.target.closest('[data-add]');
    if (add) addToCart(add.dataset.add, add);
  });

  /* ---------- Drawer ---------- */
  const drawer = $('#cart');
  const backdrop = $('[data-cart-backdrop]');
  let lastFocus = null;
  let step = 'bag';

  function openCart() {
    if (step === 'done') setStep('bag');
    lastFocus = document.activeElement;
    drawer.hidden = false;
    backdrop.hidden = false;
    document.body.classList.add('no-scroll');
    renderCart();
    $('[data-close-cart]', drawer).focus();
  }
  function closeCart() {
    drawer.hidden = true;
    backdrop.hidden = true;
    document.body.classList.remove('no-scroll');
    if (step === 'done') { setStep('bag'); }
    if (lastFocus && document.contains(lastFocus)) lastFocus.focus();
  }
  $$('[data-open-cart]').forEach((b) => b.addEventListener('click', openCart));
  drawer.addEventListener('click', (e) => { if (e.target.closest('[data-close-cart]')) closeCart(); });
  backdrop.addEventListener('click', closeCart);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!drawer.hidden) closeCart();
      else if (links.classList.contains('open')) { setNav(false); toggle.focus(); }
    }
    if (e.key === 'Tab' && !drawer.hidden) {
      const f = $$('button, [href], input, select, textarea', drawer).filter((el) => !el.disabled && el.offsetParent !== null && el.tabIndex !== -1);
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  });

  const nextBtn = $('[data-next]');
  const backBtn = $('[data-back]');
  function setStep(s) {
    step = s;
    $$('[data-step]', drawer).forEach((el) => { el.hidden = el.dataset.step !== s; });
    $('[data-cart-title]').textContent = { bag: 'Your bag', checkout: 'Checkout', done: 'Order placed' }[s];
    backBtn.hidden = s !== 'checkout';
    $('[data-done-foot]').hidden = s !== 'done';
    renderCart();
  }

  function renderCart() {
    const entries = MENU ? cartEntries() : [];
    const count = entries.reduce((n, [, q]) => n + q, 0);
    const badge = $('[data-cart-count]');
    badge.hidden = count === 0;
    badge.textContent = count;
    $('.cart-btn').setAttribute('aria-label', `Open your bag, ${count} item${count === 1 ? '' : 's'}`);

    $('[data-cart-empty]').hidden = entries.length > 0;
    $('[data-cart-lines]').innerHTML = entries.map(([id, q]) => {
      const it = ITEMS[id];
      return `
        <li class="cart-line">
          <span class="cart-line-name">${esc(it.name)}</span>
          <span class="cart-line-price">${money(it.price * q)}</span>
          <span class="qty">
            <button type="button" data-qty="${id}" data-d="-1" aria-label="Remove one ${esc(it.name)}"><svg width="16" height="16" aria-hidden="true"><use href="#i-minus"/></svg></button>
            <output aria-label="Quantity">${q}</output>
            <button type="button" data-qty="${id}" data-d="1" aria-label="Add one more ${esc(it.name)}"><svg width="16" height="16" aria-hidden="true"><use href="#i-plus"/></svg></button>
          </span>
          <button class="line-remove" type="button" data-remove="${id}">Remove</button>
        </li>`;
    }).join('');

    const t = totals();
    $('[data-subtotal]').textContent = money(t.subtotal);
    $('[data-tax]').textContent = money(t.tax);
    $('[data-total]').textContent = money(t.total);
    $('[data-cart-foot]').hidden = entries.length === 0 || step === 'done';
    if (!nextBtn.classList.contains('is-loading')) {
      nextBtn.textContent = step !== 'checkout' ? 'Checkout'
        : onlinePayment ? `Pay ${money(t.total)}` : `Place order · ${money(t.total)}`;
    }
  }

  $('[data-cart-lines]').addEventListener('click', (e) => {
    const q = e.target.closest('[data-qty]');
    const r = e.target.closest('[data-remove]');
    if (q) {
      const id = q.dataset.qty;
      cart[id] = Math.max(0, Math.min(20, (cart[id] || 0) + Number(q.dataset.d)));
      if (!cart[id]) delete cart[id];
    } else if (r) {
      delete cart[r.dataset.remove];
    } else return;
    saveCart();
    renderCart();
    if (!cartEntries().length) $('[data-close-cart]', drawer).focus();
  });

  /* ---------- Shared form helpers ---------- */
  function clearErrors(form) {
    $$('[data-err-for]', form).forEach((el) => { el.textContent = ''; });
    $$('[aria-invalid]', form).forEach((el) => el.removeAttribute('aria-invalid'));
    const fe = $('[data-form-error]', form);
    fe.hidden = true;
    fe.textContent = '';
  }
  function showErrors(form, errors) {
    let first = null;
    Object.entries(errors || {}).forEach(([key, msg]) => {
      const slot = $(`[data-err-for="${key}"]`, form);
      const input = form.elements[key];
      if (slot) {
        slot.textContent = msg;
        slot.id = slot.id || `${form.id}-${key}-err`;
      }
      const el = input && (input.length && !input.tagName ? input[0] : input);
      if (el && el.setAttribute) {
        el.setAttribute('aria-invalid', 'true');
        if (slot) el.setAttribute('aria-describedby', slot.id);
        first = first || el;
      }
      if (!slot || key === 'form' || key === 'items') {
        const fe = $('[data-form-error]', form);
        fe.textContent = msg;
        fe.hidden = false;
        first = first || fe;
      }
    });
    if (first) { if (first.tabIndex < 0 && !first.matches('input,select,textarea')) first.tabIndex = -1; first.focus(); }
  }
  const formData = (form) => Object.fromEntries(new FormData(form).entries());
  function setLoading(btn, on, label) {
    btn.classList.toggle('is-loading', on);
    btn.disabled = on;
    if (label) btn.dataset.label = btn.dataset.label || btn.textContent;
    if (on && label) btn.textContent = label;
    if (!on && btn.dataset.label) { btn.textContent = btn.dataset.label; delete btn.dataset.label; }
  }
  const NET_ERR = { form: 'We couldn’t reach the café. Check your connection and try again, or call (480) 496-4200.' };

  /* ---------- Checkout ---------- */
  const checkoutForm = $('#checkout-form');
  const carField = $('[data-car-field]');
  checkoutForm.addEventListener('change', (e) => {
    if (e.target.name === 'order_type') carField.hidden = e.target.value !== 'curbside';
  });

  function renderPickupOptions(statusMsg) {
    const sel = $('[data-pickup-select]');
    const hint = $('[data-pickup-hint]');
    const opts = [];
    if (storeOpen) opts.push('<option value="asap">As soon as possible (~15 min)</option>');
    pickupSlots.forEach((s) => opts.push(`<option value="${s}">Today at ${to12h(s)}</option>`));
    sel.innerHTML = opts.join('');
    if (!opts.length) {
      sel.innerHTML = '<option value="">No pickup times left today</option>';
      sel.disabled = true;
      hint.textContent = `Online ordering is closed for today. ${statusMsg}.`;
    } else {
      sel.disabled = false;
      hint.textContent = storeOpen ? '' : `We're closed right now — schedule a pickup for later today.`;
    }
  }

  nextBtn.addEventListener('click', async () => {
    if (step === 'bag') {
      if (!cartEntries().length) return;
      setStep('checkout');
      $('[name="order_type"]:checked', checkoutForm).focus();
      return;
    }
    if (step !== 'checkout') return;
    clearErrors(checkoutForm);
    const data = formData(checkoutForm);
    data.items = cartEntries().map(([id, qty]) => ({ id, qty }));
    setLoading(nextBtn, true, onlinePayment ? 'Opening secure payment…' : 'Placing order…');
    try {
      const order = await api('/api/orders', { method: 'POST', body: JSON.stringify(data) });
      if (order.checkout_url) {
        // Bag stays saved until Stripe confirms payment; button stays busy while the page leaves
        window.location.assign(order.checkout_url);
        return;
      }
      cart = {};
      saveCart();
      showOrderDone(order);
    } catch (err) {
      showErrors(checkoutForm, err.data?.errors || NET_ERR);
    }
    setLoading(nextBtn, false);
    renderCart();
  });

  // Browser "Back" from Stripe can restore this page from cache with the button still busy
  window.addEventListener('pageshow', (e) => {
    if (e.persisted && nextBtn.classList.contains('is-loading')) { setLoading(nextBtn, false); renderCart(); }
  });

  /* ---------- Coming back from Stripe Checkout ---------- */
  async function handleStripeReturn() {
    const params = new URLSearchParams(location.search);
    const paid = params.get('paid');
    const cancelled = params.get('cancelled');
    if (!paid && !cancelled) return;
    history.replaceState(null, '', location.pathname + location.hash);

    if (cancelled) {
      api(`/api/orders/${encodeURIComponent(cancelled)}/abandon`, { method: 'POST' }).catch(() => {});
      toast('Payment cancelled — you weren’t charged. Your bag is still here.');
      openCart();
      return;
    }
    openCart();
    setStep('done');
    $('[data-order-code]').textContent = 'Confirming your payment…';
    $('[data-order-text]').textContent = '';
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const order = await api(`/api/orders/${encodeURIComponent(paid)}/confirm`, {
          method: 'POST', body: JSON.stringify({ session_id: params.get('session_id') }),
        });
        cart = {};
        saveCart();
        showOrderDone(order);
        return;
      } catch (err) {
        if (attempt === 3) {
          $('[data-order-code]').textContent = `Order #${paid}`;
          $('[data-order-text]').textContent = err.data?.errors?.form
            || 'We couldn’t confirm your payment. Please call (480) 496-4200 and we’ll sort it out.';
        } else {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }
  }
  backBtn.addEventListener('click', () => { setStep('bag'); nextBtn.focus(); });

  let pollTimer;
  function showOrderDone(order) {
    setStep('done');
    $('[data-order-code]').textContent = `Order #${order.code}`;
    const paid = order.payment_status === 'paid';
    const where = order.order_type === 'curbside' ? "We'll bring it out to your car." : 'Grab it at the pickup counter.';
    const pay = paid ? `Paid ${money(order.total)} by card — nothing to pay at pickup.`
      : order.order_type === 'curbside' ? 'Pay when we hand it over.' : 'Pay at the counter.';
    $('[data-order-text]').textContent = `${where} Pickup: ${order.pickup_time}. ${pay}`;
    $('[data-receipt]').innerHTML = order.items.map((l) => `<li><span>${l.qty} × ${esc(l.name)}</span><span>${money(l.total)}</span></li>`).join('')
      + `<li><span>Tax</span><span>${money(order.tax)}</span></li><li class="total"><span>${paid ? 'Paid by card' : 'Total due at pickup'}</span><span>${money(order.total)}</span></li>`;
    setTrack(order.status);
    $('[data-order-success]').focus();
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const s = await api(`/api/orders/${order.code}`);
        setTrack(s.status);
        if (['ready', 'completed', 'cancelled'].includes(s.status)) {
          clearInterval(pollTimer);
          if (s.status === 'ready') toast(`Order #${order.code} is ready for pickup!`);
          if (s.status === 'cancelled') toast(`Order #${order.code} was cancelled. Please call the café.`);
        }
      } catch (_) { /* keep polling */ }
    }, 15000);
  }
  function setTrack(status) {
    const order = ['new', 'preparing', 'ready'];
    const idx = status === 'completed' ? 2 : order.indexOf(status);
    $$('[data-track] li').forEach((li, i) => li.classList.toggle('on', i <= idx));
  }
  $('[data-new-order]').addEventListener('click', () => { clearInterval(pollTimer); checkoutForm.reset(); carField.hidden = true; setStep('bag'); closeCart(); document.getElementById('menu').scrollIntoView(); });

  /* ---------- Reservations ---------- */
  const resForm = $('#reserve-form');
  const dateInput = $('#res-date');
  const partySel = $('#res-party');
  const slotsBox = $('[data-slots]');
  let chosenTime = '';
  const azToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date());
  (function initDates() {
    const today = azToday();
    const max = new Date(`${today}T12:00:00`);
    max.setDate(max.getDate() + 30);
    dateInput.min = today;
    dateInput.max = max.toISOString().slice(0, 10);
    dateInput.value = today;
  })();

  async function loadSlots() {
    chosenTime = '';
    if (!dateInput.value) { slotsBox.innerHTML = '<p class="hint">Pick a date to see open times.</p>'; return; }
    slotsBox.innerHTML = '<p class="hint">Checking open tables…</p>';
    try {
      const { slots } = await api(`/api/availability?date=${encodeURIComponent(dateInput.value)}&party=${partySel.value}`);
      const open = slots.filter((s) => s.available);
      if (!open.length) {
        slotsBox.innerHTML = '<p class="hint">No tables left that day. Try another date.</p>';
        return;
      }
      slotsBox.innerHTML = slots.map((s) => `<button type="button" class="slot" data-time="${s.time}" aria-pressed="false" ${s.available ? '' : 'disabled aria-label="' + s.label + ', unavailable"'}>${s.label}</button>`).join('');
    } catch (err) {
      slotsBox.innerHTML = `<p class="hint">${esc(err.data?.errors?.date || 'Could not load times. Please try again.')}</p>`;
    }
  }
  slotsBox.addEventListener('click', (e) => {
    const b = e.target.closest('.slot');
    if (!b || b.disabled) return;
    $$('.slot', slotsBox).forEach((s) => s.setAttribute('aria-pressed', 'false'));
    b.setAttribute('aria-pressed', 'true');
    chosenTime = b.dataset.time;
    $('[data-err-for="time"]', resForm).textContent = '';
  });
  dateInput.addEventListener('change', loadSlots);
  partySel.addEventListener('change', loadSlots);
  loadSlots();

  resForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(resForm);
    if (!chosenTime) {
      $('[data-err-for="time"]', resForm).textContent = 'Choose a time.';
      ($('.slot:not(:disabled)', slotsBox) || dateInput).focus();
      return;
    }
    const btn = $('button[type="submit"]', resForm);
    setLoading(btn, true);
    try {
      const r = await api('/api/reservations', { method: 'POST', body: JSON.stringify({ ...formData(resForm), time: chosenTime }) });
      const panel = resForm.closest('.panel');
      resForm.hidden = true;
      const done = $('[data-success]', panel);
      $('[data-success-text]', done).textContent = `Table for ${r.party} on ${r.when}. See you soon, ${r.name.split(' ')[0]}!`;
      $('[data-success-code]', done).textContent = `Confirmation #${r.code}`;
      done.hidden = false;
      done.focus({ preventScroll: true });
      panel.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    } catch (err) {
      showErrors(resForm, err.data?.errors || NET_ERR);
      if (err.data?.errors?.time) loadSlots();
    } finally {
      setLoading(btn, false);
    }
  });

  /* ---------- Contact ---------- */
  const contactForm = $('#contact-form');
  contactForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearErrors(contactForm);
    const btn = $('button[type="submit"]', contactForm);
    setLoading(btn, true);
    try {
      await api('/api/contact', { method: 'POST', body: JSON.stringify(formData(contactForm)) });
      contactForm.hidden = true;
      const panel = contactForm.closest('.panel');
      const done = $('[data-success]', panel);
      done.hidden = false;
      done.focus({ preventScroll: true });
      panel.scrollIntoView({ block: 'start', behavior: reduceMotion ? 'auto' : 'smooth' });
    } catch (err) {
      showErrors(contactForm, err.data?.errors || NET_ERR);
    } finally {
      setLoading(btn, false);
    }
  });
  $$('[data-topic]').forEach((a) => a.addEventListener('click', () => { $('#c-topic').value = a.dataset.topic; }));

  $$('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    const panel = b.closest('.panel');
    const form = $('form', panel);
    form.reset();
    clearErrors(form);
    form.hidden = false;
    $('[data-success]', panel).hidden = true;
    if (form === resForm) { dateInput.value = azToday(); loadSlots(); }
    $('input:not([type=hidden]):not(.hp), select', form).focus();
  }));

  /* ---------- Scroll reveal ---------- */
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const targets = $$('.perk, .card, .promo, .visit-info, .map, .panel, .section-title');
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    targets.forEach((el, i) => {
      el.classList.add('reveal');
      el.style.transitionDelay = `${(i % 3) * 60}ms`;
      io.observe(el);
    });
  }

  /* ---------- Active nav link ---------- */
  const navLinks = $$('.nav-links a');
  const sections = navLinks.map((a) => document.querySelector(a.getAttribute('href')));
  if ('IntersectionObserver' in window) {
    const navIo = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        navLinks.forEach((a) => a.removeAttribute('aria-current'));
        const link = navLinks[sections.indexOf(entry.target)];
        if (link) link.setAttribute('aria-current', 'true');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    sections.forEach((s) => s && navIo.observe(s));
    navIo.observe($('.hero'));
  }

  $$('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });

  loadMenu();
  loadStatus();
  handleStripeReturn();
  setInterval(loadStatus, 5 * 60 * 1000);
})();
