"""Virtual Food Expo: FastAPI server. Run with:  .venv/bin/uvicorn app:app --port 8000"""
import base64
import hashlib
import json
import os
import random
import re
import secrets
import time
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend import agents, db, llm
from backend.ui_strings import UI_STRINGS

ROOT = Path(__file__).resolve().parent
app = FastAPI(title="Virtual Food Expo")

MAX_MESSAGE_CHARS = 1000
RATE_LIMIT = (15, 60)  # 15 AI requests per 60 seconds per session
_hits: dict[str, deque] = defaultdict(deque)


def guard(session: str, text: str = "") -> None:
    """Cheap protection against abuse: message length and request rate."""
    if len(text) > MAX_MESSAGE_CHARS:
        db.log_safety("too_long", f"message of {len(text)} chars rejected")
        raise HTTPException(413, f"Messages are limited to {MAX_MESSAGE_CHARS} characters.")
    now = time.time()
    hits = _hits[session]
    while hits and now - hits[0] > RATE_LIMIT[1]:
        hits.popleft()
    if len(hits) >= RATE_LIMIT[0]:
        db.log_safety("rate_limited", f"session {session} sent too many requests")
        raise HTTPException(429, "Too many requests. Please wait a moment.")
    hits.append(now)


@app.exception_handler(llm.BudgetExceeded)
async def _budget(_: Request, e: llm.BudgetExceeded):
    return JSONResponse({"detail": str(e)}, status_code=429)


@app.exception_handler(llm.ContentBlocked)
async def _blocked(_: Request, e: llm.ContentBlocked):
    return JSONResponse({"detail": str(e)}, status_code=400)


@app.exception_handler(llm.MissingApiKey)
async def _nokey(_: Request, e: llm.MissingApiKey):
    return JSONResponse({"detail": str(e)}, status_code=500)


# ------------------------------------------------------------------ accounts, login, admin review

LICENSE_DIR = ROOT / "data" / "licenses"
MAX_LICENSE_BYTES = 5 * 1024 * 1024
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
# Admin password: set ADMIN_PASSWORD in .env. If it is missing, a random one is printed when the server starts.
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD") or secrets.token_urlsafe(9)
if not os.getenv("ADMIN_PASSWORD"):
    print(f"\n  Admin page: http://localhost:8000/#/admin   password (this run only): {ADMIN_PASSWORD}\n")
OPEN_PATHS = {"/", "/api/login", "/api/forgot", "/api/reset", "/api/languages", "/api/ui"}


@app.middleware("http")
async def require_login(request: Request, call_next):
    """Every /api call except login, labels, admin and calendar downloads needs a logged-in account."""
    p = request.url.path
    if p.startswith("/api/") and p not in OPEN_PATHS and not p.startswith("/api/admin") and not p.endswith(".ics"):
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        acct = db.one("SELECT * FROM accounts WHERE token=?", (token,)) if token else None
        if not acct:
            return JSONResponse({"detail": "Please log in first."}, status_code=401)
        request.state.account = acct
    response = await call_next(request)
    if p == "/" or p.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache"  # always re-check, so an updated app never shows old styling
    return response


def check_admin(request: Request) -> None:
    key = request.headers.get("X-Admin-Key") or request.query_params.get("key") or ""
    if not secrets.compare_digest(key, ADMIN_PASSWORD):
        raise HTTPException(401, "Wrong admin password.")


def own_vendor(request: Request, vendor_id: str) -> None:
    if request.state.account["vendor_id"] != vendor_id:
        raise HTTPException(403, "This is not your booth.")


def public_account(a: dict) -> dict:
    return {k: a[k] for k in ("id", "email", "company", "role", "vendor_id", "status", "license_name")}


class LoginIn(BaseModel):
    mode: str = "login"  # 'login' | 'signup'
    email: str
    password: str = ""
    company: str = ""
    role: str = "buyer"  # 'buyer' | 'vendor'
    license_b64: str | None = None
    license_name: str | None = None


def read_license(b64: str) -> bytes:
    """Decode and check an uploaded license: must be a real PDF, 5 MB at most."""
    try:
        raw = base64.b64decode(b64, validate=True)
    except Exception:
        raise HTTPException(400, "The license file could not be read.")
    if len(raw) > MAX_LICENSE_BYTES:
        raise HTTPException(413, "The license file is too large (5 MB maximum).")
    if not raw.startswith(b"%PDF"):
        raise HTTPException(400, "The license must be a PDF file.")
    return raw


def save_license(account_id: int, raw: bytes) -> None:
    LICENSE_DIR.mkdir(parents=True, exist_ok=True)
    (LICENSE_DIR / f"{account_id}.pdf").write_bytes(raw)


def vendor_for_new_account(company: str) -> str:
    """A vendor account gets a booth: the demo company with the same name, or a new empty booth."""
    for v in db.all_vendors():
        if v["name"].lower() == company.lower():
            return v["id"]
    vid = "u" + secrets.token_hex(3)
    booth = {"id": vid, "name": company, "city": "", "country": "", "emoji": "🏪", "category": "New vendors", "certifications": [],
             "rating": 0, "language": "en", "description": "New to the expo. Edit this text in My booth.", "products": [],
             "shipping_weeks": {}, "sample_policy": "Ask us about samples.", "faqs": [], "auto_accept": True, "private": {}}
    db.run("INSERT INTO vendors (id, data) VALUES (?, ?)", (vid, json.dumps(booth)))
    return vid


PASSWORD_MIN = 8
LOGIN_FAILS = (5, 300)  # 5 wrong passwords per email per 5 minutes, then a pause
_fails: dict[str, deque] = defaultdict(deque)


def hash_password(password: str, salt: str | None = None) -> str:
    """Salted PBKDF2. Only this hash is stored, never the password."""
    salt = salt or secrets.token_hex(16)
    return salt + "$" + hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def password_ok(password: str, stored: str | None) -> bool:
    if not stored or "$" not in stored:
        return False
    return secrets.compare_digest(hash_password(password, stored.split("$")[0]), stored)


@app.post("/api/login")
def login(body: LoginIn):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(400, "Please enter a valid email address.")
    acct = db.one("SELECT * FROM accounts WHERE email=?", (email,))

    if body.mode == "login":
        now = time.time()
        fails = _fails[email]
        while fails and now - fails[0] > LOGIN_FAILS[1]:
            fails.popleft()
        if len(fails) >= LOGIN_FAILS[0]:
            db.log_safety("login_locked", f"too many wrong passwords for {email}")
            raise HTTPException(429, "Too many wrong passwords. Please wait a few minutes and try again.")
        if not acct or not password_ok(body.password, acct["password_hash"]):
            fails.append(now)
            raise HTTPException(401, "That email or password is not right.")  # same message either way
        fails.clear()
        return {"token": acct["token"], "account": public_account(acct)}

    # sign up
    if acct:
        raise HTTPException(409, "An account with that email already exists. Please log in.")
    company = body.company.strip()[:120]
    if not company:
        raise HTTPException(400, "Please enter your company name.")
    if len(body.password) < PASSWORD_MIN:
        raise HTTPException(400, f"Your password needs at least {PASSWORD_MIN} characters.")
    if body.role not in ("buyer", "vendor"):
        raise HTTPException(400, "Choose buyer or vendor.")
    license_bytes = read_license(body.license_b64) if body.license_b64 else None  # check before creating anything
    vendor_id = vendor_for_new_account(company) if body.role == "vendor" else None
    aid = db.run("INSERT INTO accounts (email, company, role, vendor_id, token, password_hash) VALUES (?,?,?,?,?,?)",
                 (email, company, body.role, vendor_id, secrets.token_urlsafe(24), hash_password(body.password)))
    if license_bytes:
        save_license(aid, license_bytes)
        db.run("UPDATE accounts SET license_name=?, status='pending' WHERE id=?", ((body.license_name or "license.pdf")[:120], aid))
    acct = db.one("SELECT * FROM accounts WHERE id=?", (aid,))
    return {"token": acct["token"], "account": public_account(acct)}


# ---- forgot password: a one-time link, valid 30 minutes, sent by email

RESET_MINUTES = 30
FORGOT_LIMIT = (3, 900)  # 3 reset emails per address per 15 minutes
_forgot: dict[str, deque] = defaultdict(deque)


def send_email(to: str, subject: str, body: str) -> bool:
    """Send through SMTP if SMTP_HOST (and friends) are set in .env. Otherwise print the message in the server terminal."""
    host = os.getenv("SMTP_HOST")
    if not host:
        print(f"\n--- EMAIL NOT SENT (no SMTP_HOST in .env). It would have gone to {to} ---\n{subject}\n{body}\n---\n")
        return False
    import smtplib
    from email.message import EmailMessage
    msg = EmailMessage()
    msg["From"] = os.getenv("SMTP_FROM") or os.getenv("SMTP_USER") or "no-reply@virtual-food-expo"
    msg["To"], msg["Subject"] = to, subject
    msg.set_content(body)
    try:
        with smtplib.SMTP(host, int(os.getenv("SMTP_PORT", 587)), timeout=15) as s:
            s.starttls()
            if os.getenv("SMTP_USER"):
                s.login(os.getenv("SMTP_USER"), os.getenv("SMTP_PASSWORD", ""))
            s.send_message(msg)
        return True
    except Exception as e:  # never tell the visitor whether the email worked, but do tell the server log
        db.log_safety("email_failed", f"reset email to {to} failed: {type(e).__name__}")
        print(f"Email failed: {e}")
        return False


class ForgotIn(BaseModel):
    email: str


@app.post("/api/forgot")
def forgot(body: ForgotIn, request: Request):
    email = body.email.strip().lower()
    reply = {"ok": True}  # the same answer whether or not the address has an account
    if not EMAIL_RE.match(email):
        return reply
    now = time.time()
    q = _forgot[email]
    while q and now - q[0] > FORGOT_LIMIT[1]:
        q.popleft()
    if len(q) >= FORGOT_LIMIT[0]:
        db.log_safety("forgot_limited", f"too many reset requests for {email}")
        return reply
    q.append(now)
    acct = db.one("SELECT * FROM accounts WHERE email=?", (email,))
    if not acct:
        return reply
    token = secrets.token_urlsafe(32)
    db.run("INSERT INTO password_resets (token_hash, account_id, expires) VALUES (?,?,?)",
           (hashlib.sha256(token.encode()).hexdigest(), acct["id"], now + RESET_MINUTES * 60))
    base = (os.getenv("APP_URL") or str(request.base_url)).rstrip("/")
    send_email(email, "Reset your Virtual Food Expo password",
               f"Hello {acct['company']},\n\nUse this link to choose a new password (valid {RESET_MINUTES} minutes):\n\n"
               f"{base}/#/reset/{token}\n\nIf you did not ask for this, you can ignore this email.")
    return reply


class ResetIn(BaseModel):
    token: str
    password: str


@app.post("/api/reset")
def reset_password(body: ResetIn):
    if len(body.password) < PASSWORD_MIN:
        raise HTTPException(400, f"Your password needs at least {PASSWORD_MIN} characters.")
    row = db.one("SELECT * FROM password_resets WHERE token_hash=?", (hashlib.sha256(body.token.encode()).hexdigest(),))
    if not row or row["used"] or row["expires"] < time.time():
        raise HTTPException(400, "This reset link is not valid any more. Please ask for a new one.")
    acct = db.one("SELECT * FROM accounts WHERE id=?", (row["account_id"],))
    # new password, one-time link used up, and a new session token so any old sessions are signed out
    db.run("UPDATE accounts SET password_hash=?, token=? WHERE id=?", (hash_password(body.password), secrets.token_urlsafe(24), acct["id"]))
    db.run("UPDATE password_resets SET used=1 WHERE token_hash=?", (row["token_hash"],))
    _fails.pop(acct["email"], None)
    return {"ok": True}


@app.get("/api/me")
def me(request: Request):
    return public_account(request.state.account)


@app.get("/api/admin/accounts")
def admin_accounts(request: Request):
    check_admin(request)
    return db.q("SELECT id, email, company, role, vendor_id, license_name, status, created FROM accounts ORDER BY "
                "CASE status WHEN 'pending' THEN 0 ELSE 1 END, id DESC")


@app.get("/api/admin/license/{account_id}")
def admin_license(account_id: int, request: Request):
    check_admin(request)
    path = LICENSE_DIR / f"{account_id}.pdf"
    if not path.exists():
        raise HTTPException(404, "No license on file")
    return Response(path.read_bytes(), media_type="application/pdf")


class ReviewIn(BaseModel):
    approve: bool


@app.post("/api/admin/accounts/{account_id}/review")
def admin_review(account_id: int, body: ReviewIn, request: Request):
    check_admin(request)
    a = db.one("SELECT * FROM accounts WHERE id=?", (account_id,))
    if not a:
        raise HTTPException(404, "Account not found")
    db.run("UPDATE accounts SET status=? WHERE id=?", ("verified" if body.approve else "rejected", account_id))
    if a["vendor_id"]:  # a verified vendor gets a badge on its booth
        v = db.get_vendor(a["vendor_id"])
        v["verified"] = body.approve
        db.save_vendor(v)
    return {"ok": True}


# ------------------------------------------------------------------ pages and labels

@app.get("/")
def index():
    return FileResponse(ROOT / "static" / "index.html")


@app.get("/api/languages")
def languages():
    return [{"code": c, "name": n} for c, n in agents.LANGUAGES.items()]


@app.get("/api/ui")
def ui(lang: str = "en", session: str = "ui"):
    if lang == "en":
        return UI_STRINGS
    return agents.translate_ui(UI_STRINGS, lang, session)


# ------------------------------------------------------------------ buyer: browse and match

@app.get("/api/vendors")
def vendors():
    return [db.public_vendor(v) for v in db.all_vendors()]


@app.get("/api/vendors/{vendor_id}")
def vendor(vendor_id: str, lang: str = "en", session: str = "anon"):
    v = db.get_vendor(vendor_id)
    if not v:
        raise HTTPException(404, "Vendor not found")
    v = db.public_vendor(v)
    if lang != "en":  # translated once per language, then cached
        v["description"] = agents.translate(v["description"], "en", lang, session)["text"]
        v["sample_policy"] = agents.translate(v["sample_policy"], "en", lang, session)["text"]
    return v


class MatchIn(BaseModel):
    text: str
    lang: str = "en"
    session: str


@app.post("/api/match")
def match(body: MatchIn):
    guard(body.session, body.text)
    return agents.match(body.text, body.lang, body.session)


# ------------------------------------------------------------------ conversations

class ConvIn(BaseModel):
    vendor_id: str
    buyer_name: str = "Buyer"
    lang: str = "en"


@app.post("/api/conversations")
def start_conversation(body: ConvIn):
    existing = db.one("SELECT id FROM conversations WHERE vendor_id=? AND buyer_name=?", (body.vendor_id, body.buyer_name))
    if existing:
        return {"id": existing["id"]}
    return {"id": db.run("INSERT INTO conversations (vendor_id, buyer_name, buyer_lang) VALUES (?,?,?)",
                         (body.vendor_id, body.buyer_name, body.lang))}


@app.get("/api/buyer/dashboard")
def buyer_dashboard(request: Request, lang: str = "en", session: str = "anon"):
    """Everything the buyer's home page needs: every outreach with its meetings and samples."""
    company = request.state.account["company"]
    out = []
    for c in db.q("SELECT * FROM conversations WHERE buyer_name=? ORDER BY id DESC", (company,)):
        v = db.get_vendor(c["vendor_id"]) or {}
        last = db.one("SELECT sender, en_text, created FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1", (c["id"],))
        out.append({
            "conv_id": c["id"], "vendor_id": c["vendor_id"], "vendor_name": v.get("name", "?"), "emoji": v.get("emoji", "🏪"),
            "verified": v.get("verified", False), "created": c["created"],
            "last_text": agents.translate(last["en_text"], "en", lang, session)["text"] if last else "",
            "last_sender": last["sender"] if last else None, "last_time": last["created"] if last else c["created"],
            "meetings": db.q("SELECT id, kind, app, start_utc, proposed_by, status, link FROM meetings WHERE conv_id=? ORDER BY id", (c["id"],)),
            "samples": db.q("SELECT id, status FROM samples WHERE conv_id=? ORDER BY id", (c["id"],)),
        })
    return out


def conv_or_404(conv_id: int) -> dict:
    c = db.one("SELECT * FROM conversations WHERE id=?", (conv_id,))
    if not c:
        raise HTTPException(404, "Conversation not found")
    return c


def render_message(m: dict, viewer_lang: str, session: str) -> dict:
    """Show a message in the viewer's language. The English pivot text is translated, and cached."""
    if m["orig_lang"] == viewer_lang:
        text, check = m["orig_text"], "ok"
    else:
        t = agents.translate(m["en_text"], "en", viewer_lang, session)
        text, check = t["text"], t["number_check"]
    return {"id": m["id"], "sender": m["sender"], "text": text, "original": m["orig_text"], "orig_lang": m["orig_lang"],
            "translated": m["orig_lang"] != viewer_lang, "number_check": check, "created": m["created"]}


def add_message(conv_id: int, sender: str, text: str, lang: str, en_text: str | None = None) -> int:
    return db.run("INSERT INTO messages (conv_id, sender, orig_text, orig_lang, en_text) VALUES (?,?,?,?,?)",
                  (conv_id, sender, text, lang, en_text if en_text is not None else text))


class MessageIn(BaseModel):
    text: str
    lang: str
    side: str  # 'buyer' or 'vendor'
    session: str


@app.post("/api/conversations/{conv_id}/messages")
def post_message(conv_id: int, body: MessageIn):
    guard(body.session, body.text)
    conv = conv_or_404(conv_id)
    vendor = db.get_vendor(conv["vendor_id"])
    try:
        eng = agents.to_english(body.text, body.session)
    except llm.ContentBlocked:  # keep the chat usable: show the message, never pass it to the booth agent
        add_message(conv_id, body.side, body.text, body.lang, "[This message was removed by the safety filter.]")
        add_message(conv_id, "agent", llm.BLOCKED_NOTICE, "en")
        return {"ok": True, "blocked": True}
    add_message(conv_id, body.side, body.text, body.lang, eng["english"])
    if body.side == "vendor":
        db.run("UPDATE conversations SET human_active=1 WHERE id=?", (conv_id,))
    elif not conv["human_active"]:
        rows = db.q("SELECT sender, en_text FROM messages WHERE conv_id=? ORDER BY id", (conv_id,))
        history = [{"role": "user" if r["sender"] == "buyer" else "assistant", "content": r["en_text"]} for r in rows]
        reply = agents.booth_reply(vendor, history, body.session)
        add_message(conv_id, "agent", reply["text"], "en")
    return {"ok": True}


@app.get("/api/conversations/{conv_id}")
def get_conversation(conv_id: int, lang: str = "en", session: str = "anon"):
    conv = conv_or_404(conv_id)
    rows = db.q("SELECT * FROM messages WHERE conv_id=? ORDER BY id", (conv_id,))
    with ThreadPoolExecutor(max_workers=6) as pool:  # untranslated messages are translated side by side, not one after another
        msgs = list(pool.map(lambda m: render_message(m, lang, session), rows))
    meetings = db.q("SELECT * FROM meetings WHERE conv_id=? ORDER BY id", (conv_id,))
    samples = db.q("SELECT * FROM samples WHERE conv_id=? ORDER BY id", (conv_id,))
    return {"conversation": conv, "vendor": db.public_vendor(db.get_vendor(conv["vendor_id"])), "messages": msgs,
            "meetings": meetings, "samples": samples}


@app.post("/api/conversations/{conv_id}/brief")
def brief(conv_id: int, lang: str = "en", session: str = "anon"):
    guard(session)
    conv = conv_or_404(conv_id)
    rows = db.q("SELECT sender, en_text FROM messages WHERE conv_id=? ORDER BY id", (conv_id,))
    transcript = "\n".join(f"{r['sender']}: {r['en_text']}" for r in rows)
    text = agents.deal_brief(db.get_vendor(conv["vendor_id"]), transcript, session)
    return {"brief": agents.translate(text, "en", lang, session)["text"]}


# ------------------------------------------------------------------ quick action 1+2: meetings and video calls

class MeetingIn(BaseModel):
    kind: str  # 'meeting' | 'video'
    app: str = ""  # 'Zoom' | 'Google Meet' for video
    start_utc: str  # ISO time in UTC
    proposed_by: str  # 'buyer' | 'vendor'


def fake_link(app_name: str) -> str:
    """Placeholder link for the demo. Real Zoom/Meet links need an account connection (see README)."""
    if app_name == "Zoom":
        return f"https://zoom.us/j/{random.randint(10**9, 10**10 - 1)}"
    if app_name == "Google Meet":
        r = lambda n: "".join(random.choices("abcdefghijklmnopqrstuvwxyz", k=n))
        return f"https://meet.google.com/{r(3)}-{r(4)}-{r(3)}"
    return ""


@app.post("/api/conversations/{conv_id}/meetings")
def propose_meeting(conv_id: int, body: MeetingIn):
    conv_or_404(conv_id)
    try:
        datetime.fromisoformat(body.start_utc.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(400, "Bad time")
    mid = db.run("INSERT INTO meetings (conv_id, kind, app, start_utc, proposed_by, link) VALUES (?,?,?,?,?,?)",
                 (conv_id, body.kind, body.app, body.start_utc, body.proposed_by, fake_link(body.app)))
    if body.proposed_by == "buyer" and db.get_vendor(conv_or_404(conv_id)["vendor_id"]).get("auto_accept", True):
        db.run("UPDATE meetings SET status='accepted' WHERE id=?", (mid,))  # the booth assistant answers for the vendor
        add_message(conv_id, "agent", "Good news: I have accepted your meeting request for the vendor. "
                                      "The confirmed time and link are shown in the chat.", "en")
    return {"id": mid}


class RespondIn(BaseModel):
    accept: bool


@app.post("/api/meetings/{mid}/respond")
def respond_meeting(mid: int, body: RespondIn):
    db.run("UPDATE meetings SET status=? WHERE id=?", ("accepted" if body.accept else "declined", mid))
    return {"ok": True}


def ics_times(m: dict):
    start = datetime.fromisoformat(m["start_utc"].replace("Z", "+00:00")).astimezone(timezone.utc)
    return start, start + timedelta(minutes=30)


@app.get("/api/meetings/{mid}.ics")
def meeting_ics(mid: int):
    m = db.one("SELECT * FROM meetings WHERE id=?", (mid,))
    if not m:
        raise HTTPException(404, "Meeting not found")
    conv = conv_or_404(m["conv_id"])
    vendor = db.get_vendor(conv["vendor_id"])
    start, end = ics_times(m)
    f = lambda d: d.strftime("%Y%m%dT%H%M%SZ")
    title = f"{m['app'] + ' call' if m['app'] else 'Meeting'} with {vendor['name']}"
    ics = "\r\n".join(["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Virtual Food Expo//EN", "BEGIN:VEVENT",
                       f"UID:meeting-{mid}@virtual-food-expo", f"DTSTAMP:{f(datetime.now(timezone.utc))}",
                       f"DTSTART:{f(start)}", f"DTEND:{f(end)}", f"SUMMARY:{title}",
                       f"LOCATION:{m['link']}", f"DESCRIPTION:{m['link']}", "END:VEVENT", "END:VCALENDAR"])
    return Response(ics, media_type="text/calendar", headers={"Content-Disposition": f"attachment; filename=meeting-{mid}.ics"})


@app.get("/api/meetings/{mid}/calendar-links")
def calendar_links(mid: int):
    from urllib.parse import quote
    m = db.one("SELECT * FROM meetings WHERE id=?", (mid,))
    if not m:
        raise HTTPException(404, "Meeting not found")
    vendor = db.get_vendor(conv_or_404(m["conv_id"])["vendor_id"])
    start, end = ics_times(m)
    f = lambda d: d.strftime("%Y%m%dT%H%M%SZ")
    title = f"{m['app'] + ' call' if m['app'] else 'Meeting'} with {vendor['name']}"
    google = ("https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + quote(title) +
              f"&dates={f(start)}/{f(end)}&details=" + quote(m["link"] or ""))
    outlook = ("https://outlook.live.com/calendar/0/deeplink/compose?subject=" + quote(title) +
               f"&startdt={start.isoformat()}&enddt={end.isoformat()}&body=" + quote(m["link"] or ""))
    return {"google": google, "outlook": outlook, "ics": f"/api/meetings/{mid}.ics", "title": title}


# ------------------------------------------------------------------ quick action 3: sample requests

@app.post("/api/conversations/{conv_id}/samples")
def request_sample(conv_id: int):
    conv = conv_or_404(conv_id)
    sid = db.run("INSERT INTO samples (conv_id) VALUES (?)", (conv_id,))
    if db.get_vendor(conv["vendor_id"]).get("auto_accept", True):
        db.run("UPDATE samples SET status='confirmed' WHERE id=?", (sid,))  # the booth assistant answers for the vendor
        add_message(conv_id, "agent", "Good news: I have confirmed your sample request for the vendor. "
                                      "Please send your mailing address so we can ship it.", "en")
    return {"id": sid}


@app.post("/api/samples/{sid}/respond")
def respond_sample(sid: int, body: RespondIn):
    db.run("UPDATE samples SET status=? WHERE id=?", ("confirmed" if body.accept else "declined", sid))
    return {"ok": True}


class AddressIn(BaseModel):
    address: str


@app.post("/api/samples/{sid}/address")
def sample_address(sid: int, body: AddressIn):
    """Buyer sends an address; the vendor's automatic message explaining the shipment is added to the chat."""
    s = db.one("SELECT * FROM samples WHERE id=?", (sid,))
    if not s or s["status"] != "confirmed":
        raise HTTPException(400, "This sample request has not been confirmed")
    vendor = db.get_vendor(conv_or_404(s["conv_id"])["vendor_id"])
    db.run("UPDATE samples SET status='shipped', address=? WHERE id=?", (body.address[:300], sid))
    note = (f"Thank you! {vendor['name']} is preparing your sample. Shipping to: {body.address[:300]}. "
            f"What you will receive: {vendor['sample_policy']} It will include our product sheet and price list. "
            "We will message you a tracking number when it ships. Please tell us what you think!")
    add_message(s["conv_id"], "vendor_auto", note, "en")
    return {"ok": True}


# ------------------------------------------------------------------ vendor side

@app.get("/api/vendor/{vendor_id}/inbox")
def inbox(vendor_id: str, request: Request, lang: str = "en", session: str = "anon"):
    own_vendor(request, vendor_id)
    out = []
    for c in db.q("SELECT * FROM conversations WHERE vendor_id=? ORDER BY id DESC", (vendor_id,)):
        last = db.one("SELECT orig_text, en_text, orig_lang, created FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1", (c["id"],))
        pending_m = db.q("SELECT COUNT(*) AS n FROM meetings WHERE conv_id=? AND status='pending' AND proposed_by='buyer'", (c["id"],))[0]["n"]
        pending_s = db.q("SELECT COUNT(*) AS n FROM samples WHERE conv_id=? AND status='pending'", (c["id"],))[0]["n"]
        out.append({**c, "last_en": agents.translate(last["en_text"], "en", lang, session)["text"] if last else "", "pending_meetings": pending_m, "pending_samples": pending_s})
    return out


@app.get("/api/vendor/{vendor_id}/dashboard")
def vendor_dashboard(vendor_id: str, request: Request, lang: str = "en", session: str = "anon"):
    """Everything the vendor's home page needs: every buyer who wrote in, with meetings and samples."""
    own_vendor(request, vendor_id)
    out = []
    for c in db.q("SELECT * FROM conversations WHERE vendor_id=? ORDER BY id DESC", (vendor_id,)):
        last = db.one("SELECT sender, en_text, created FROM messages WHERE conv_id=? ORDER BY id DESC LIMIT 1", (c["id"],))
        out.append({
            "conv_id": c["id"], "buyer_name": c["buyer_name"], "created": c["created"],
            "last_text": agents.translate(last["en_text"], "en", lang, session)["text"] if last else "",
            "last_time": last["created"] if last else c["created"],
            "meetings": db.q("SELECT id, kind, app, start_utc, proposed_by, status, link FROM meetings WHERE conv_id=? ORDER BY id", (c["id"],)),
            "samples": db.q("SELECT id, status, address FROM samples WHERE conv_id=? ORDER BY id", (c["id"],)),
        })
    return out


class BoothEdit(BaseModel):
    description: str | None = None
    sample_policy: str | None = None
    add_product: dict | None = None
    auto_accept: bool | None = None


@app.put("/api/vendor/{vendor_id}/booth")
def edit_booth(vendor_id: str, body: BoothEdit, request: Request):
    own_vendor(request, vendor_id)
    v = db.get_vendor(vendor_id)
    if not v:
        raise HTTPException(404, "Vendor not found")
    if body.auto_accept is not None:
        v["auto_accept"] = body.auto_accept
    if body.description is not None:
        v["description"] = body.description[:600]
    if body.sample_policy is not None:
        v["sample_policy"] = body.sample_policy[:300]
    if body.add_product:
        p = body.add_product
        try:
            price, minimum = float(p["price"]), int(p["min_order"])
            v["products"].append({"name": str(p["name"])[:80], "unit": str(p.get("unit", "unit"))[:20], "min_order": minimum,
                                  "tiers": [{"min_qty": minimum, "price": price}]})
        except (KeyError, ValueError):
            raise HTTPException(400, "Product needs name, unit, price and min_order")
    db.save_vendor(v)
    return db.public_vendor(v)


# ------------------------------------------------------------------ transparency: tokens, cost, safety log

@app.get("/api/usage")
def usage(session: str | None = None):
    where, args = ("WHERE session=?", (session,)) if session else ("", ())
    rows = db.q(f"SELECT agent, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached, "
                f"SUM(completion_tokens) AS completion FROM usage {where} GROUP BY agent", args)
    for r in rows:
        r["cost_usd"] = round(llm.cost_usd(r["prompt"], r["cached"], r["completion"]), 6)
    total = {k: sum(r[k] for r in rows) for k in ("calls", "prompt", "cached", "completion", "cost_usd")}
    return {"by_agent": rows, "total": total, "session_cap": llm.SESSION_TOKEN_CAP, "daily_cap": llm.DAILY_TOKEN_CAP,
            "model": llm.MODEL, "assumed_prices_per_m": {"input": llm.PRICE_IN, "cached": llm.PRICE_CACHED, "output": llm.PRICE_OUT}}


@app.get("/api/safety-events")
def safety_events():
    return db.q("SELECT ts, kind, detail FROM safety_events ORDER BY id DESC LIMIT 50")


app.mount("/static", StaticFiles(directory=ROOT / "static"), name="static")
