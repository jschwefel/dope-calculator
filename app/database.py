"""SQLite persistence layer for ammo entries and IP ban list."""

import csv
import sqlite3
from pathlib import Path

_DATA = Path(__file__).parent.parent / "data"
DB_PATH = _DATA / "dope.db"
AMMO_CSV = _DATA / "ammunition.csv"


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db() -> None:
    """Create tables; migrate from CSV on first run."""
    with _connect() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS ammo (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                caliber       TEXT    NOT NULL,
                name          TEXT    NOT NULL,
                velocity_fps  REAL    NOT NULL,
                bc_g1         REAL    NOT NULL,
                bc_g7         REAL    NOT NULL,
                deleted       INTEGER NOT NULL DEFAULT 0,
                deleted_by_ip TEXT,
                deleted_at    TEXT,
                UNIQUE(caliber, name)
            );
            CREATE TABLE IF NOT EXISTS ip_bans (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                ip        TEXT    NOT NULL UNIQUE,
                reason    TEXT    NOT NULL DEFAULT '',
                banned_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
            );
        """)
        if conn.execute("SELECT COUNT(*) FROM ammo").fetchone()[0] == 0:
            _migrate_csv(conn)


def _migrate_csv(conn: sqlite3.Connection) -> None:
    if not AMMO_CSV.exists():
        return
    with open(AMMO_CSV, newline="") as f:
        for row in csv.DictReader(f):
            conn.execute(
                "INSERT OR IGNORE INTO ammo (caliber, name, velocity_fps, bc_g1, bc_g7) VALUES (?,?,?,?,?)",
                (row.get("caliber", "Unknown"), row["name"],
                 float(row["velocity_fps"]), float(row["bc_g1"]), float(row["bc_g7"])),
            )


# ── Ammo queries ──────────────────────────────────────────────────────────────

def load_ammo(include_deleted: bool = False) -> list[dict]:
    sql = "SELECT * FROM ammo" if include_deleted else "SELECT * FROM ammo WHERE deleted=0"
    with _connect() as conn:
        return [dict(r) for r in conn.execute(sql + " ORDER BY caliber, name")]


def caliber_list() -> list[str]:
    seen: list[str] = []
    for a in load_ammo():
        if a["caliber"] not in seen:
            seen.append(a["caliber"])
    return seen


def ammo_exists(caliber: str, name: str) -> bool:
    with _connect() as conn:
        return conn.execute(
            "SELECT 1 FROM ammo WHERE caliber=? AND name=? AND deleted=0", (caliber, name)
        ).fetchone() is not None


def add_ammo(entry: dict) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO ammo (caliber, name, velocity_fps, bc_g1, bc_g7) VALUES (?,?,?,?,?)",
            (entry["caliber"], entry["name"], entry["velocity_fps"],
             entry["bc_g1"], entry["bc_g7"]),
        )


def edit_ammo(original_name: str, updates: dict) -> bool:
    allowed = {"caliber", "name", "velocity_fps", "bc_g1", "bc_g7"}
    fields = {k: v for k, v in updates.items() if k in allowed}
    if not fields:
        return False
    set_clause = ", ".join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [original_name]
    with _connect() as conn:
        cur = conn.execute(
            f"UPDATE ammo SET {set_clause} WHERE name=? AND deleted=0", values
        )
        return cur.rowcount > 0


def soft_delete_ammo(name: str, ip: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE ammo SET deleted=1, deleted_by_ip=?, deleted_at=datetime('now','localtime')"
            " WHERE name=? AND deleted=0",
            (ip, name),
        )
        return cur.rowcount > 0


def list_deleted() -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM ammo WHERE deleted=1 ORDER BY deleted_at DESC"
        )]


def restore_ammo(name: str) -> bool:
    with _connect() as conn:
        cur = conn.execute(
            "UPDATE ammo SET deleted=0, deleted_by_ip=NULL, deleted_at=NULL WHERE name=?",
            (name,),
        )
        return cur.rowcount > 0


# ── IP ban queries ────────────────────────────────────────────────────────────

def is_banned(ip: str) -> bool:
    with _connect() as conn:
        return conn.execute("SELECT 1 FROM ip_bans WHERE ip=?", (ip,)).fetchone() is not None


def list_bans() -> list[dict]:
    with _connect() as conn:
        return [dict(r) for r in conn.execute("SELECT * FROM ip_bans ORDER BY banned_at DESC")]


def ban_ip(ip: str, reason: str = "") -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO ip_bans (ip, reason, banned_at)"
            " VALUES (?, ?, datetime('now','localtime'))",
            (ip, reason),
        )


def unban_ip(ip: str) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM ip_bans WHERE ip=?", (ip,))
        return cur.rowcount > 0
