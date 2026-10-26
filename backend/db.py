"""SQLite storage: vendors, conversations, messages, requests, translation cache, token usage, safety events."""
import json
import sqlite3
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_PATH = ROOT / "data" / "expo.db"
VENDORS_JSON = ROOT / "data" / "vendors.json"

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS vendors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, vendor_id TEXT, buyer_name TEXT, buyer_lang TEXT,
  human_active INTEGER DEFAULT 0, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER, sender TEXT, orig_text TEXT, orig_lang TEXT,
  en_text TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS meetings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER, kind TEXT, app TEXT, start_utc TEXT,
  proposed_by TEXT, status TEXT DEFAULT 'pending', link TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id INTEGER, status TEXT DEFAULT 'pending',
  address TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, company TEXT, role TEXT, vendor_id TEXT,
  license_name TEXT, status TEXT DEFAULT 'none', token TEXT, created TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY, account_id INTEGER, expires REAL, used INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS translations (key TEXT, lang TEXT, text TEXT, PRIMARY KEY (key, lang));
CREATE TABLE IF NOT EXISTS usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP, agent TEXT, session TEXT,
  prompt_tokens INTEGER, cached_tokens INTEGER, completion_tokens INTEGER);
CREATE TABLE IF NOT EXISTS safety_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT DEFAULT CURRENT_TIMESTAMP, kind TEXT, detail TEXT);
"""


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


_conn = None


def conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        DB_PATH.parent.mkdir(exist_ok=True)
        _conn = connect()
        _conn.executescript(SCHEMA)
        try:  # databases made before passwords existed get the new column
            _conn.execute("ALTER TABLE accounts ADD COLUMN password_hash TEXT")
            _conn.commit()
        except sqlite3.OperationalError:
            pass
        seed_vendors()
    return _conn


def q(sql: str, args=()) -> list[dict]:
    with _lock:
        return [dict(r) for r in conn().execute(sql, args).fetchall()]


def one(sql: str, args=()) -> dict | None:
    rows = q(sql, args)
    return rows[0] if rows else None


def run(sql: str, args=()) -> int:
    with _lock:
        cur = conn().execute(sql, args)
        conn().commit()
        return cur.lastrowid


def seed_vendors() -> None:
    """Load the fake demo vendors the first time the database is created."""
    c = _conn
    if c.execute("SELECT COUNT(*) FROM vendors").fetchone()[0] == 0:
        for v in json.loads(VENDORS_JSON.read_text(encoding="utf-8")):
            c.execute("INSERT INTO vendors (id, data) VALUES (?, ?)", (v["id"], json.dumps(v)))
        c.commit()


def all_vendors() -> list[dict]:
    return [json.loads(r["data"]) for r in q("SELECT data FROM vendors ORDER BY id")]


def get_vendor(vendor_id: str) -> dict | None:
    r = one("SELECT data FROM vendors WHERE id=?", (vendor_id,))
    return json.loads(r["data"]) if r else None


def save_vendor(v: dict) -> None:
    run("UPDATE vendors SET data=? WHERE id=?", (json.dumps(v), v["id"]))


def public_vendor(v: dict) -> dict:
    """Everything a buyer (or a booth agent) is allowed to see. The 'private' block never leaves the server."""
    return {k: val for k, val in v.items() if k != "private"}


def log_safety(kind: str, detail: str) -> None:
    run("INSERT INTO safety_events (kind, detail) VALUES (?, ?)", (kind, detail[:500]))
