#!/usr/bin/env python3
"""Tropical Smoothie Cafe Tempe — website + ordering/reservations/contact backend.

Standard library only (Python 3.9+). Run:  python3 server.py
Environment variables (all optional):
  PORT          port to listen on (default 5178)
  ADMIN_KEY     staff dashboard key (otherwise generated into data/admin_key.txt)
  SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, NOTIFY_EMAIL
                send an email to NOTIFY_EMAIL for every new order/reservation/message
  STRIPE_SECRET_KEY      turns on card payment at checkout (sk_test_... or sk_live_...)
  STRIPE_WEBHOOK_SECRET  whsec_... from the Stripe webhook for /api/stripe/webhook
  PUBLIC_URL             the site's public address, e.g. https://tropicaltempe.com
"""
import hashlib
import hmac
import json
import urllib.error
import urllib.parse
import urllib.request
import mimetypes
import os
import re
import secrets
import smtplib
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent
PUBLIC = ROOT / "public"
DATA = ROOT / "data"
DB_PATH = DATA / "tsc.db"
MENU_PATH = DATA / "menu.json"

AZ = timezone(timedelta(hours=-7))  # Arizona: MST all year, no DST
# weekday() -> (open hour, close hour); Monday = 0
HOURS = {0: (6, 21), 1: (6, 21), 2: (6, 21), 3: (6, 21), 4: (6, 22), 5: (7, 22), 6: (7, 21)}

RES_MAX_PARTY = 8
RES_MAX_PER_SLOT = 4      # bookings per 30-minute slot
RES_MAX_SEATS_PER_SLOT = 20
RES_DAYS_AHEAD = 30

ORDER_STATUSES = ["new", "preparing", "ready", "completed", "cancelled"]
# Orders waiting on card payment use "awaiting_payment" and "abandoned"; staff never set these.

STRIPE_KEY = os.environ.get("STRIPE_SECRET_KEY", "")
STRIPE_WEBHOOK_SECRET = os.environ.get("STRIPE_WEBHOOK_SECRET", "")
STRIPE_API = os.environ.get("STRIPE_API_BASE", "https://api.stripe.com")  # override only for local testing
RES_STATUSES = ["confirmed", "seated", "completed", "cancelled", "no-show"]
MSG_STATUSES = ["new", "handled"]

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
db_lock = threading.Lock()


# ---------- setup ----------
def get_admin_key():
    key = os.environ.get("ADMIN_KEY")
    if key:
        return key
    path = DATA / "admin_key.txt"
    if not path.exists():
        path.write_text(secrets.token_urlsafe(12))
        os.chmod(path, 0o600)
    return path.read_text().strip()


def init_db():
    DATA.mkdir(exist_ok=True)
    with sqlite3.connect(DB_PATH) as con:
        con.executescript(
            """
            CREATE TABLE IF NOT EXISTS orders (
              id INTEGER PRIMARY KEY, code TEXT UNIQUE, created_at TEXT, status TEXT,
              name TEXT, phone TEXT, email TEXT, order_type TEXT, car TEXT,
              pickup_time TEXT, notes TEXT, items TEXT, subtotal REAL, tax REAL, total REAL
            );
            CREATE TABLE IF NOT EXISTS reservations (
              id INTEGER PRIMARY KEY, code TEXT UNIQUE, created_at TEXT, status TEXT,
              name TEXT, phone TEXT, email TEXT, date TEXT, time TEXT, party INTEGER, notes TEXT
            );
            CREATE TABLE IF NOT EXISTS messages (
              id INTEGER PRIMARY KEY, created_at TEXT, status TEXT,
              name TEXT, email TEXT, phone TEXT, topic TEXT, message TEXT
            );
            """
        )
        cols = {r[1] for r in con.execute("PRAGMA table_info(orders)")}
        for col in ("payment_status", "stripe_session", "payment_intent", "paid_at"):
            if col not in cols:
                con.execute(f"ALTER TABLE orders ADD COLUMN {col} TEXT")


def db():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    return con


def load_menu():
    return json.loads(MENU_PATH.read_text())


def menu_index(menu):
    return {item["id"]: item for cat in menu["categories"] for item in cat["items"]}


# ---------- time helpers ----------
def now_az():
    return datetime.now(AZ)


def fmt_time(t):
    return t.strftime("%-I:%M %p")


def day_hours(d):
    o, c = HOURS[d.weekday()]
    start = datetime(d.year, d.month, d.day, o, tzinfo=AZ)
    end = datetime(d.year, d.month, d.day, c, tzinfo=AZ)
    return start, end


def store_status():
    n = now_az()
    start, end = day_hours(n)
    is_open = start <= n < end
    if is_open:
        nxt = f"Open until {fmt_time(end)}"
    elif n < start:
        nxt = f"Opens today at {fmt_time(start)}"
    else:
        tstart, _ = day_hours(n + timedelta(days=1))
        nxt = f"Opens tomorrow at {fmt_time(tstart)}"
    return {"open": is_open, "message": nxt, "now": n.isoformat()}


def pickup_slots(prep_minutes):
    """15-minute pickup slots for the rest of today."""
    n = now_az()
    start, end = day_hours(n)
    earliest = max(n + timedelta(minutes=prep_minutes), start + timedelta(minutes=prep_minutes))
    minute = (earliest.minute // 15 + 1) * 15
    t = earliest.replace(minute=0, second=0, microsecond=0) + timedelta(minutes=minute)
    slots = []
    while t <= end - timedelta(minutes=15):
        slots.append(t.strftime("%H:%M"))
        t += timedelta(minutes=15)
    return slots


def reservation_slots(date_str, party):
    try:
        d = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=AZ)
    except ValueError:
        raise ValueError("Pick a valid date.")
    today = now_az().replace(hour=0, minute=0, second=0, microsecond=0)
    if d < today or d > today + timedelta(days=RES_DAYS_AHEAD):
        raise ValueError(f"Reservations can be made up to {RES_DAYS_AHEAD} days ahead.")
    start, end = day_hours(d)
    cutoff = now_az() + timedelta(minutes=30)
    with db() as con:
        rows = con.execute(
            "SELECT time, COUNT(*) AS n, SUM(party) AS seats FROM reservations "
            "WHERE date = ? AND status IN ('confirmed','seated') GROUP BY time",
            (date_str,),
        ).fetchall()
    booked = {r["time"]: (r["n"], r["seats"] or 0) for r in rows}
    slots = []
    t = start
    while t <= end - timedelta(minutes=60):
        key = t.strftime("%H:%M")
        n, seats = booked.get(key, (0, 0))
        ok = t >= cutoff and n < RES_MAX_PER_SLOT and seats + party <= RES_MAX_SEATS_PER_SLOT
        slots.append({"time": key, "label": fmt_time(t), "available": ok})
        t += timedelta(minutes=30)
    return slots


# ---------- validation ----------
class Invalid(Exception):
    def __init__(self, errors):
        self.errors = errors


def clean(value, max_len):
    return str(value or "").strip()[:max_len]


def check_contact(payload, errors, need_phone=True):
    name = clean(payload.get("name"), 80)
    email = clean(payload.get("email"), 120)
    phone = re.sub(r"[^\d+]", "", clean(payload.get("phone"), 30))
    if len(name) < 2:
        errors["name"] = "Enter your name."
    if email and not EMAIL_RE.match(email):
        errors["email"] = "Enter a valid email, like name@example.com."
    if need_phone and len(re.sub(r"\D", "", phone)) < 10:
        errors["phone"] = "Enter a 10-digit phone number so we can reach you."
    return name, email, phone


def new_code(prefix, table):
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    with db() as con:
        while True:
            code = prefix + "".join(secrets.choice(alphabet) for _ in range(5))
            if not con.execute(f"SELECT 1 FROM {table} WHERE code = ?", (code,)).fetchone():
                return code


# ---------- notifications ----------
def notify(subject, body):
    host, to = os.environ.get("SMTP_HOST"), os.environ.get("NOTIFY_EMAIL")
    print(f"[notify] {subject}")
    if not (host and to):
        return

    def send():
        try:
            msg = EmailMessage()
            msg["Subject"], msg["To"] = subject, to
            msg["From"] = os.environ.get("SMTP_USER", to)
            msg.set_content(body)
            with smtplib.SMTP(host, int(os.environ.get("SMTP_PORT", 587)), timeout=15) as s:
                s.starttls()
                if os.environ.get("SMTP_USER"):
                    s.login(os.environ["SMTP_USER"], os.environ.get("SMTP_PASS", ""))
                s.send_message(msg)
        except Exception as e:  # never break a customer request over email
            print(f"[notify] email failed: {e}")

    threading.Thread(target=send, daemon=True).start()


# ---------- Stripe ----------
class StripeError(Exception):
    pass


def stripe(method, path, params=None):
    """Minimal Stripe REST call (form-encoded), no SDK needed."""
    data = urllib.parse.urlencode(params or [], doseq=True).encode() if method == "POST" else None
    req = urllib.request.Request(f"{STRIPE_API}{path}", data=data, method=method)
    req.add_header("Authorization", f"Bearer {STRIPE_KEY}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", str(e))
        except Exception:
            msg = str(e)
        raise StripeError(msg)
    except (urllib.error.URLError, TimeoutError) as e:
        raise StripeError(str(e))


def create_checkout_session(code, lines, tax, email, base_url):
    params = [
        ("mode", "payment"),
        ("client_reference_id", code),
        ("metadata[order_code]", code),
        ("payment_intent_data[metadata][order_code]", code),
        ("payment_intent_data[description]", f"Tropical Smoothie Cafe Tempe order {code}"),
        ("success_url", f"{base_url}/?paid={code}&session_id={{CHECKOUT_SESSION_ID}}"),
        ("cancel_url", f"{base_url}/?cancelled={code}"),
        ("expires_at", str(int(time.time()) + 30 * 60)),
    ]
    if email:
        params.append(("customer_email", email))
    items = [(l["name"], int(round(l["price"] * 100)), l["qty"]) for l in lines]
    if tax > 0:
        items.append(("Sales tax", int(round(tax * 100)), 1))
    for i, (name, cents, qty) in enumerate(items):
        params += [
            (f"line_items[{i}][price_data][currency]", "usd"),
            (f"line_items[{i}][price_data][product_data][name]", name),
            (f"line_items[{i}][price_data][unit_amount]", str(cents)),
            (f"line_items[{i}][quantity]", str(qty)),
        ]
    return stripe("POST", "/v1/checkout/sessions", params)


def mark_paid(code, payment_intent):
    """Idempotent: moves an order from awaiting_payment to the kitchen queue."""
    with db_lock, db() as con:
        cur = con.execute(
            "UPDATE orders SET status = 'new', payment_status = 'paid', payment_intent = ?, paid_at = ? "
            "WHERE code = ? AND payment_status = 'unpaid'",
            (payment_intent, now_az().isoformat(), code),
        )
        row = con.execute("SELECT * FROM orders WHERE code = ?", (code,)).fetchone()
    if cur.rowcount and row:
        notify_order(row)
    return row


def notify_order(row):
    lines = json.loads(row["items"])
    summary = "\n".join(f"{l['qty']} x {l['name']}" for l in lines)
    paid = "PAID ONLINE" if row["payment_status"] == "paid" else "pay at pickup"
    notify(f"New order {row['code']} — ${row['total']:.2f} {paid} ({row['order_type']}, {row['pickup_time']})",
           f"{row['name']} · {row['phone']}\n{summary}\nTotal ${row['total']:.2f}\nNotes: {row['notes']}")


def public_order(row):
    return {"code": row["code"], "status": row["status"], "pickup_time": row["pickup_time"],
            "order_type": row["order_type"], "items": json.loads(row["items"]),
            "subtotal": row["subtotal"], "tax": row["tax"], "total": row["total"],
            "payment_status": row["payment_status"]}


def verify_stripe_signature(payload, header):
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    t, sigs = parts.get("t", ""), [p.split("=", 1)[1] for p in header.split(",") if p.startswith("v1=")]
    if not t or not sigs or abs(time.time() - int(t)) > 300:
        return False
    expected = hmac.new(STRIPE_WEBHOOK_SECRET.encode(), f"{t}.".encode() + payload, hashlib.sha256).hexdigest()
    return any(hmac.compare_digest(expected, s) for s in sigs)


# ---------- handlers ----------
def create_order(p, base_url=""):
    menu = load_menu()
    index = menu_index(menu)
    errors = {}
    if clean(p.get("website"), 50):  # honeypot
        raise Invalid({"form": "Something went wrong. Please call the cafe."})
    name, email, phone = check_contact(p, errors)
    order_type = p.get("order_type") if p.get("order_type") in ("pickup", "curbside") else None
    if not order_type:
        errors["order_type"] = "Choose pickup or curbside."
    car = clean(p.get("car"), 80)
    if order_type == "curbside" and len(car) < 3:
        errors["car"] = "Tell us your car's color and model so we can find you."

    lines, subtotal = [], 0.0
    for raw in (p.get("items") or [])[:50]:
        item = index.get(str(raw.get("id")))
        try:
            qty = int(raw.get("qty", 0))
        except (TypeError, ValueError):
            qty = 0
        if not item or not 1 <= qty <= 20:
            continue
        line_total = round(item["price"] * qty, 2)
        subtotal += line_total
        lines.append({"id": item["id"], "name": item["name"], "qty": qty,
                      "price": item["price"], "total": line_total,
                      "note": clean(raw.get("note"), 120)})
    if not lines:
        errors["items"] = "Your bag is empty — add something from the menu."

    status = store_status()
    slots = pickup_slots(menu.get("prep_minutes", 15))
    when = clean(p.get("pickup_time"), 10) or "asap"
    if when == "asap":
        if not status["open"]:
            if slots:
                errors["pickup_time"] = f"We're closed right now. Choose a time later today ({status['message']})."
            else:
                errors["form"] = f"Online ordering is closed for today. {status['message']}."
    elif when not in slots:
        errors["pickup_time"] = "That pickup time isn't available anymore. Pick another."
    if errors:
        raise Invalid(errors)

    subtotal = round(subtotal, 2)
    tax = round(subtotal * float(menu.get("tax_rate", 0)), 2)
    total = round(subtotal + tax, 2)
    if when == "asap":
        ready = now_az() + timedelta(minutes=menu.get("prep_minutes", 15))
        pickup_label = f"ASAP (about {fmt_time(ready)})"
    else:
        h, m = map(int, when.split(":"))
        pickup_label = fmt_time(now_az().replace(hour=h, minute=m))
    code = new_code("T", "orders")
    pay_online = bool(STRIPE_KEY)
    status, payment_status = ("awaiting_payment", "unpaid") if pay_online else ("new", "at_pickup")
    with db_lock, db() as con:
        con.execute(
            "INSERT INTO orders (code, created_at, status, name, phone, email, order_type, car, "
            "pickup_time, notes, items, subtotal, tax, total, payment_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (code, now_az().isoformat(), status, name, phone, email, order_type, car, pickup_label,
             clean(p.get("notes"), 300), json.dumps(lines), subtotal, tax, total, payment_status),
        )
        row = con.execute("SELECT * FROM orders WHERE code = ?", (code,)).fetchone()

    if not pay_online:
        notify_order(row)
        return public_order(row)

    try:
        session = create_checkout_session(code, lines, tax, email, base_url)
    except StripeError as e:
        print(f"[stripe] checkout session failed for {code}: {e}")
        with db_lock, db() as con:
            con.execute("UPDATE orders SET status = 'abandoned' WHERE code = ?", (code,))
        raise Invalid({"form": "Card payment isn't available right now. Please try again in a minute, or call (480) 496-4200."})
    with db_lock, db() as con:
        con.execute("UPDATE orders SET stripe_session = ? WHERE code = ?", (session["id"], code))
    return {**public_order(row), "checkout_url": session["url"]}


def confirm_payment(code, session_id):
    """Called when the customer comes back from Stripe; double-checks with Stripe directly."""
    with db() as con:
        row = con.execute("SELECT * FROM orders WHERE code = ?", (code,)).fetchone()
    if not row or not session_id or row["stripe_session"] != session_id:
        raise Invalid({"form": "We couldn't find that order."})
    if row["payment_status"] == "paid":
        return public_order(row)
    session = stripe("GET", f"/v1/checkout/sessions/{urllib.parse.quote(session_id)}")
    if session.get("payment_status") != "paid" or session.get("client_reference_id") != code:
        raise Invalid({"form": "Your payment hasn't gone through yet. If you were charged, call (480) 496-4200."})
    return public_order(mark_paid(code, session.get("payment_intent") or ""))


def abandon_payment(code):
    """Customer backed out of Stripe Checkout: drop the pending order and close its session."""
    with db_lock, db() as con:
        row = con.execute("SELECT * FROM orders WHERE code = ? AND status = 'awaiting_payment'", (code,)).fetchone()
        if not row:
            return
        con.execute("UPDATE orders SET status = 'abandoned' WHERE code = ?", (code,))
    if row["stripe_session"]:
        try:
            stripe("POST", f"/v1/checkout/sessions/{urllib.parse.quote(row['stripe_session'])}/expire")
        except StripeError:
            pass  # already expired or completed; the webhook/confirm path handles a late payment


def create_reservation(p):
    errors = {}
    if clean(p.get("website"), 50):
        raise Invalid({"form": "Something went wrong. Please call the cafe."})
    name, email, phone = check_contact(p, errors)
    try:
        party = int(p.get("party", 0))
    except (TypeError, ValueError):
        party = 0
    if not 1 <= party <= RES_MAX_PARTY:
        errors["party"] = f"Party size must be 1–{RES_MAX_PARTY}. For bigger groups, call us."
    date_str, time_str = clean(p.get("date"), 10), clean(p.get("time"), 5)
    if not errors.get("party"):
        try:
            slots = {s["time"]: s for s in reservation_slots(date_str, party)}
            if time_str not in slots or not slots[time_str]["available"]:
                errors["time"] = "That time is no longer available. Pick another."
        except ValueError as e:
            errors["date"] = str(e)
    if errors:
        raise Invalid(errors)
    code = new_code("R", "reservations")
    with db_lock, db() as con:
        con.execute(
            "INSERT INTO reservations (code, created_at, status, name, phone, email, date, time, party, notes) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (code, now_az().isoformat(), "confirmed", name, phone, email, date_str, time_str,
             party, clean(p.get("notes"), 300)),
        )
    h, m = map(int, time_str.split(":"))
    label = datetime.strptime(date_str, "%Y-%m-%d").strftime("%A, %B %-d") + " at " + \
        fmt_time(datetime(2000, 1, 1, h, m))
    notify(f"New reservation {code} — {party} guests, {label}", f"{name} · {phone} · {email}\n{p.get('notes', '')}")
    return {"code": code, "when": label, "party": party, "name": name}


def create_message(p):
    errors = {}
    if clean(p.get("website"), 50):
        raise Invalid({"form": "Something went wrong. Please call the cafe."})
    name, email, phone = check_contact(p, errors, need_phone=False)
    if not email and len(re.sub(r"\D", "", phone)) < 10:
        errors["email"] = "Leave an email or phone number so we can reply."
    message = clean(p.get("message"), 2000)
    if len(message) < 5:
        errors["message"] = "Write a short message (at least 5 characters)."
    topic = clean(p.get("topic"), 40) or "General"
    if errors:
        raise Invalid(errors)
    with db_lock, db() as con:
        con.execute(
            "INSERT INTO messages (created_at, status, name, email, phone, topic, message) VALUES (?,?,?,?,?,?,?)",
            (now_az().isoformat(), "new", name, email, phone, topic, message),
        )
    notify(f"New message from {name} — {topic}", f"{email} {phone}\n\n{message}")
    return {"ok": True}


RATE = {}


def rate_limited(ip, limit=20, window=600):
    t = time.time()
    hits = [h for h in RATE.get(ip, []) if t - h < window]
    hits.append(t)
    RATE[ip] = hits
    return len(hits) > limit


class Handler(BaseHTTPRequestHandler):
    server_version = "TSCTempe/1.0"

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}")

    # --- helpers
    def send_json(self, data, status=200):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > 50_000:
            raise Invalid({"form": "Request too large."})
        try:
            return json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            raise Invalid({"form": "Invalid request."})

    def is_admin(self):
        return hmac.compare_digest(self.headers.get("X-Admin-Key", ""), ADMIN_KEY)

    # --- routing
    def do_GET(self):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        if path == "/api/menu":
            menu = load_menu()
            menu.pop("_note", None)
            return self.send_json(menu)
        if path == "/api/status":
            menu = load_menu()
            return self.send_json({**store_status(), "pickup_slots": pickup_slots(menu.get("prep_minutes", 15)),
                                   "online_payment": bool(STRIPE_KEY)})
        if path == "/api/availability":
            try:
                party = int((qs.get("party") or ["2"])[0])
                return self.send_json({"slots": reservation_slots((qs.get("date") or [""])[0], max(1, min(party, RES_MAX_PARTY)))})
            except ValueError as e:
                return self.send_json({"errors": {"date": str(e)}}, 400)
        m = re.fullmatch(r"/api/orders/([A-Z0-9]{6})", path)
        if m:
            with db() as con:
                row = con.execute("SELECT code, status, pickup_time, order_type, total FROM orders WHERE code = ?", (m.group(1),)).fetchone()
            return self.send_json(dict(row)) if row else self.send_json({"error": "Order not found"}, 404)
        if path.startswith("/api/admin/"):
            if not self.is_admin():
                return self.send_json({"error": "Unauthorized"}, 401)
            return self.admin_get(path, qs)
        return self.serve_static(path)

    def base_url(self):
        if os.environ.get("PUBLIC_URL"):
            return os.environ["PUBLIC_URL"].rstrip("/")
        proto = self.headers.get("X-Forwarded-Proto", "http")
        return f"{proto}://{self.headers.get('Host', 'localhost')}"

    def do_POST(self):
        path = urlparse(self.path).path
        handlers = {
            "/api/orders": lambda p: create_order(p, self.base_url()),
            "/api/reservations": create_reservation,
            "/api/contact": create_message,
        }
        if path == "/api/admin/login":
            return self.send_json({"ok": True}) if self.is_admin() else self.send_json({"error": "Wrong key"}, 401)
        if path == "/api/stripe/webhook":
            return self.stripe_webhook()
        m = re.fullmatch(r"/api/orders/([A-Z0-9]{6})/(confirm|abandon)", path)
        if m:
            try:
                if m.group(2) == "abandon":
                    abandon_payment(m.group(1))
                    return self.send_json({"ok": True})
                return self.send_json(confirm_payment(m.group(1), str(self.read_json().get("session_id", ""))))
            except Invalid as e:
                return self.send_json({"errors": e.errors}, 400)
            except StripeError as e:
                print(f"[stripe] confirm failed: {e}")
                return self.send_json({"errors": {"form": "We couldn't confirm your payment yet. Refresh in a moment."}}, 502)
        if path not in handlers:
            return self.send_json({"error": "Not found"}, 404)
        if rate_limited(self.client_address[0]):
            return self.send_json({"errors": {"form": "Too many requests. Please wait a few minutes or call us."}}, 429)
        try:
            return self.send_json(handlers[path](self.read_json()), 201)
        except Invalid as e:
            return self.send_json({"errors": e.errors}, 400)

    def stripe_webhook(self):
        length = int(self.headers.get("Content-Length") or 0)
        payload = self.rfile.read(min(length, 500_000))
        if not STRIPE_WEBHOOK_SECRET or not verify_stripe_signature(payload, self.headers.get("Stripe-Signature", "")):
            return self.send_json({"error": "Invalid signature"}, 400)
        event = json.loads(payload)
        obj = event.get("data", {}).get("object", {})
        if event.get("type") in ("checkout.session.completed", "checkout.session.async_payment_succeeded") \
                and obj.get("payment_status") == "paid":
            code = obj.get("client_reference_id") or obj.get("metadata", {}).get("order_code")
            with db() as con:
                row = con.execute("SELECT stripe_session FROM orders WHERE code = ?", (code,)).fetchone()
            if row and row["stripe_session"] == obj.get("id"):
                mark_paid(code, obj.get("payment_intent") or "")
        return self.send_json({"received": True})

    def do_PATCH(self):
        path = urlparse(self.path).path
        if not self.is_admin():
            return self.send_json({"error": "Unauthorized"}, 401)
        m = re.fullmatch(r"/api/admin/(orders|reservations|messages)/(\d+)", path)
        if not m:
            return self.send_json({"error": "Not found"}, 404)
        table, rid = m.group(1), int(m.group(2))
        allowed = {"orders": ORDER_STATUSES, "reservations": RES_STATUSES, "messages": MSG_STATUSES}[table]
        try:
            status = self.read_json().get("status")
        except Invalid as e:
            return self.send_json({"errors": e.errors}, 400)
        if status not in allowed:
            return self.send_json({"error": f"Status must be one of {allowed}"}, 400)
        if table == "orders" and status == "cancelled":
            with db() as con:
                row = con.execute("SELECT * FROM orders WHERE id = ?", (rid,)).fetchone()
            if row and row["payment_status"] == "paid":
                try:
                    stripe("POST", "/v1/refunds", [("payment_intent", row["payment_intent"]),
                                                   ("metadata[order_code]", row["code"])])
                except StripeError as e:
                    return self.send_json({"error": f"Refund failed, order not cancelled: {e}"}, 502)
                with db_lock, db() as con:
                    con.execute("UPDATE orders SET payment_status = 'refunded' WHERE id = ?", (rid,))
        with db_lock, db() as con:
            cur = con.execute(f"UPDATE {table} SET status = ? WHERE id = ?", (status, rid))
        return self.send_json({"ok": cur.rowcount == 1})

    def admin_get(self, path, qs):
        with db() as con:
            if path == "/api/admin/orders":
                rows = con.execute("SELECT * FROM orders WHERE status NOT IN ('awaiting_payment','abandoned') "
                                   "ORDER BY id DESC LIMIT 200").fetchall()
                return self.send_json([{**dict(r), "items": json.loads(r["items"])} for r in rows])
            if path == "/api/admin/reservations":
                today = now_az().strftime("%Y-%m-%d")
                rows = con.execute("SELECT * FROM reservations WHERE date >= ? ORDER BY date, time LIMIT 300", (today,)).fetchall()
                return self.send_json([dict(r) for r in rows])
            if path == "/api/admin/messages":
                rows = con.execute("SELECT * FROM messages ORDER BY id DESC LIMIT 200").fetchall()
                return self.send_json([dict(r) for r in rows])
            if path == "/api/admin/summary":
                today = now_az().strftime("%Y-%m-%d")
                return self.send_json({
                    "new_orders": con.execute("SELECT COUNT(*) FROM orders WHERE status IN ('new','preparing')").fetchone()[0],
                    "today_sales": con.execute("SELECT COALESCE(SUM(total),0) FROM orders WHERE status NOT IN ('cancelled','awaiting_payment','abandoned') AND substr(created_at,1,10) = ?", (today,)).fetchone()[0],
                    "today_reservations": con.execute("SELECT COUNT(*) FROM reservations WHERE date = ? AND status IN ('confirmed','seated')", (today,)).fetchone()[0],
                    "new_messages": con.execute("SELECT COUNT(*) FROM messages WHERE status = 'new'").fetchone()[0],
                })
        return self.send_json({"error": "Not found"}, 404)

    def serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        elif path in ("/admin", "/admin/"):
            path = "/admin.html"
        target = (PUBLIC / path.lstrip("/")).resolve()
        if PUBLIC not in target.parents or not target.is_file():
            self.send_response(404)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"Not found")
            return
        body = target.read_bytes()
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype + ("; charset=utf-8" if ctype.startswith("text/") or ctype.endswith("javascript") else ""))
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)


init_db()
ADMIN_KEY = get_admin_key()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5178))
    print(f"Tropical Smoothie Cafe Tempe running on http://localhost:{port}")
    print(f"Staff dashboard: http://localhost:{port}/admin  (key in data/admin_key.txt or $ADMIN_KEY)")
    if STRIPE_KEY:
        mode = "TEST mode" if STRIPE_KEY.startswith(("sk_test_", "rk_test_")) else "LIVE mode"
        print(f"Card payments: ON via Stripe ({mode})" + ("" if STRIPE_WEBHOOK_SECRET else " — no STRIPE_WEBHOOK_SECRET, relying on return-page confirmation"))
    else:
        print("Card payments: OFF (set STRIPE_SECRET_KEY to turn on). Orders are pay-at-pickup.")
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
