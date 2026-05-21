#!/usr/bin/env python3
"""
dope-admin — CLI for the DOPE Calculator admin API.

Admin key is read from the DOPE_ADMIN_KEY environment variable.
Override the server URL with DOPE_URL (default: http://localhost:5000).

Usage:
  dope-admin bans list
  dope-admin bans add <ip> [--reason REASON]
  dope-admin bans remove <ip>
  dope-admin deleted list
  dope-admin deleted restore <name>
  dope-admin visits [--top N] [--log-dir DIR] [--host-id ID]
"""

import argparse
import gzip
import os
import re
import sys
from collections import Counter
from pathlib import Path

import requests

BASE_URL = os.environ.get("DOPE_URL", "http://localhost:5000").rstrip("/")
ADMIN_KEY = os.environ.get("DOPE_ADMIN_KEY", "")


def _headers() -> dict:
    if not ADMIN_KEY:
        print("ERROR: DOPE_ADMIN_KEY environment variable is not set.", file=sys.stderr)
        sys.exit(1)
    return {"X-Admin-Key": ADMIN_KEY}


def _get(path: str) -> dict:
    r = requests.get(BASE_URL + path, headers=_headers(), timeout=10)
    _check(r)
    return r.json()


def _post(path: str, body: dict | None = None) -> dict:
    r = requests.post(BASE_URL + path, headers=_headers(),
                      json=body or {}, timeout=10)
    _check(r)
    return r.json()


def _delete(path: str) -> dict:
    r = requests.delete(BASE_URL + path, headers=_headers(), timeout=10)
    _check(r)
    return r.json()


def _check(r: requests.Response) -> None:
    if not r.ok:
        try:
            msg = r.json().get("error", r.text)
        except Exception:
            msg = r.text
        print(f"ERROR {r.status_code}: {msg}", file=sys.stderr)
        sys.exit(1)


def _print_table(rows: list[dict], columns: list[tuple[str, str]]) -> None:
    """Print a simple fixed-width table. columns = [(header, key), ...]"""
    if not rows:
        print("  (none)")
        return
    widths = [max(len(hdr), max(len(str(r.get(key, ""))) for r in rows))
              for hdr, key in columns]
    fmt = "  " + "  ".join(f"{{:<{w}}}" for w in widths)
    sep = "  " + "  ".join("-" * w for w in widths)
    print(fmt.format(*[h for h, _ in columns]))
    print(sep)
    for row in rows:
        print(fmt.format(*[str(row.get(k, "")) for _, k in columns]))


NPM_LOG_DIR = os.environ.get(
    "NPM_LOG_DIR", "/opt/containers/nginx-proxy-manager/data/logs"
)
NPM_HOST_ID = os.environ.get("NPM_HOST_ID", "19")

_CLIENT_RE = re.compile(r'\[Client ([^\]]+)\]')


# -- Subcommand handlers -------------------------------------------------------

def cmd_bans_list(_args):
    data = _get("/api/admin/bans")
    bans = data["bans"]
    print(f"IP bans ({len(bans)}):")
    _print_table(bans, [("IP", "ip"), ("Reason", "reason"), ("Banned at", "banned_at")])


def cmd_bans_add(args):
    data = _post("/api/admin/bans", {"ip": args.ip, "reason": args.reason})
    print(f"Banned: {data['banned']}")


def cmd_bans_remove(args):
    data = _delete(f"/api/admin/bans/{args.ip}")
    print(f"Unbanned: {data['unbanned']}")


def cmd_deleted_list(_args):
    data = _get("/api/admin/deleted")
    rows = data["deleted"]
    print(f"Soft-deleted ammo ({len(rows)}):")
    _print_table(rows, [
        ("Name",       "name"),
        ("Caliber",    "caliber"),
        ("Deleted by", "deleted_by_ip"),
        ("Deleted at", "deleted_at"),
    ])


def cmd_deleted_restore(args):
    quoted = requests.utils.quote(args.name, safe="")
    data = _post(f"/api/admin/restore/{quoted}")
    print(f"Restored: {data['restored']}")


def cmd_visits(args):
    log_dir = Path(args.log_dir)
    if not log_dir.is_dir():
        print(f"ERROR: log directory not found: {log_dir}", file=sys.stderr)
        sys.exit(1)

    pattern = f"proxy-host-{args.host_id}_access.log*"
    files = sorted(log_dir.glob(pattern))
    if not files:
        print(f"ERROR: no log files matching {pattern} in {log_dir}", file=sys.stderr)
        sys.exit(1)

    counts: Counter = Counter()
    for f in files:
        opener = gzip.open if f.suffix == ".gz" else open
        try:
            with opener(f, "rt", errors="replace") as fh:
                for line in fh:
                    m = _CLIENT_RE.search(line)
                    if m:
                        counts[m.group(1)] += 1
        except OSError as exc:
            print(f"  warning: could not read {f.name}: {exc}", file=sys.stderr)

    if not counts:
        print("No visit data found.")
        return

    top = counts.most_common(args.top if args.top else None)
    total = sum(counts.values())

    ip_w = max(len("IP Address"), max(len(ip) for ip, _ in top))
    fmt = f"  {{:<{ip_w}}}  {{:>8}}"
    sep = "  " + "-" * ip_w + "  " + "-" * 8

    print(fmt.format("IP Address", "Visits"))
    print(sep)
    for ip, n in top:
        print(fmt.format(ip, n))
    print(sep)
    print(fmt.format("TOTAL", total))
    print(fmt.format("Unique IPs", len(counts)))


# -- Argument parser -----------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="dope-admin",
        description="Admin CLI for the DOPE Calculator.",
    )
    sub = p.add_subparsers(dest="group", metavar="COMMAND")
    sub.required = True

    # bans
    bans = sub.add_parser("bans", help="Manage IP ban list")
    bans_sub = bans.add_subparsers(dest="action", metavar="ACTION")
    bans_sub.required = True

    bans_sub.add_parser("list", help="List all banned IPs").set_defaults(func=cmd_bans_list)

    p_ban = bans_sub.add_parser("add", help="Ban an IP address")
    p_ban.add_argument("ip", help="IP address to ban")
    p_ban.add_argument("--reason", default="", metavar="TEXT", help="Optional reason")
    p_ban.set_defaults(func=cmd_bans_add)

    p_unban = bans_sub.add_parser("remove", help="Remove an IP ban")
    p_unban.add_argument("ip", help="IP address to unban")
    p_unban.set_defaults(func=cmd_bans_remove)

    # deleted
    deleted = sub.add_parser("deleted", help="Manage soft-deleted ammo")
    deleted_sub = deleted.add_subparsers(dest="action", metavar="ACTION")
    deleted_sub.required = True

    deleted_sub.add_parser("list", help="List soft-deleted ammo entries").set_defaults(func=cmd_deleted_list)

    p_restore = deleted_sub.add_parser("restore", help="Restore a deleted ammo entry")
    p_restore.add_argument("name", help="Exact ammo name to restore")
    p_restore.set_defaults(func=cmd_deleted_restore)

    # visits
    p_visits = sub.add_parser("visits", help="Report unique visitor IPs from NPM logs")
    p_visits.add_argument("--top", type=int, default=0, metavar="N",
                          help="Show only top N IPs (default: all)")
    p_visits.add_argument("--log-dir", default=NPM_LOG_DIR, metavar="DIR",
                          help=f"NPM log directory (default: {NPM_LOG_DIR})")
    p_visits.add_argument("--host-id", default=NPM_HOST_ID, metavar="ID",
                          help=f"NPM proxy host ID (default: {NPM_HOST_ID})")
    p_visits.set_defaults(func=cmd_visits)

    return p


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
