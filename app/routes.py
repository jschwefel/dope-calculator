"""Flask routes for the DOPE calculator."""

import io
import os
from flask import Blueprint, jsonify, render_template, request, send_file
from flask_limiter import RateLimitExceeded

from .factory import limiter
from .ballistics import interpolate_dope
from .pdf_generator import generate_dope_pdf, generate_dope_pdf_multi
from . import database as db

bp = Blueprint("main", __name__)

ADMIN_KEY = os.environ.get("DOPE_ADMIN_KEY", "")

_WIND_TO_FPS = {
    "mph":  1.46667,
    "fps":  1.0,
    "km/h": 0.91134,
    "m/s":  3.28084,
}


# ── Helpers ───────────────────────────────────────────────────────────────────

def _client_ip() -> str:
    return request.headers.get("X-Forwarded-For", request.remote_addr or "").split(",")[0].strip()


def _require_admin():
    key = request.headers.get("X-Admin-Key", "")
    if not ADMIN_KEY or key != ADMIN_KEY:
        return jsonify({"error": "Unauthorized"}), 401
    return None


def _check_banned():
    ip = _client_ip()
    if db.is_banned(ip):
        return jsonify({"error": "Forbidden"}), 403
    return None


# ── Pages ─────────────────────────────────────────────────────────────────────

@bp.route("/")
def index():
    return render_template("index.html",
                           ammo_list=db.load_ammo(),
                           calibers=db.caliber_list())


# ── Calculate ─────────────────────────────────────────────────────────────────

@bp.route("/api/calculate", methods=["POST"])
def calculate():
    data = request.get_json(force=True)

    velocity_fps   = float(data.get("velocity_fps", 1070))
    bc_model       = data.get("bc_model", "g7").lower()
    bc             = float(data.get("bc_g7" if bc_model == "g7" else "bc_g1", 0.067))
    zero_yards     = float(data.get("zero_yards", 50))
    altitude_ft    = float(data.get("altitude_ft", 0))
    temp_f         = float(data.get("temp_f", 59))
    sight_h        = float(data.get("sight_height_in", 1.5))
    dope_entries   = data.get("dope_entries", [])
    out_distances  = [float(d) for d in data.get("output_distances", [])]

    # Wind parameters
    wind_speed     = float(data.get("wind_speed", 0.0))
    wind_unit      = data.get("wind_unit", "mph")
    wind_angle_deg = float(data.get("wind_angle_deg", 0.0))
    wind_fps       = wind_speed * _WIND_TO_FPS.get(wind_unit, 1.46667)

    if not out_distances:
        return jsonify({"error": "No output distances specified"}), 400

    results = {}
    for dist in out_distances:
        val = interpolate_dope(
            dope_entries=dope_entries,
            target_distance=dist,
            muzzle_velocity_fps=velocity_fps,
            bc=bc,
            zero_distance_yards=zero_yards,
            altitude_ft=altitude_ft,
            temp_f=temp_f,
            bc_model=bc_model,
            sight_height_in=sight_h,
            wind_speed_fps=wind_fps,
            wind_angle_deg=wind_angle_deg,
        )
        results[str(int(dist))] = {"elevation": val["elevation"], "windage": val["windage"]}

    return jsonify({"results": results})


# ── PDF ───────────────────────────────────────────────────────────────────────

@bp.route("/api/generate-pdf", methods=["POST"])
def generate_pdf():
    data = request.get_json(force=True)

    label_row    = int(data.get("label_row", 1))
    label_col    = int(data.get("label_col", 1))
    session_name = data.get("session_name", "")
    offset_x     = float(data.get("offset_x_in", 0.0))
    offset_y     = float(data.get("offset_y_in", 0.0))
    fill_sheet   = bool(data.get("fill_sheet", False))
    adj_decimals = int(data.get("adj_decimals", 1))

    if not (1 <= label_row <= 5):
        return jsonify({"error": "label_row must be 1–5"}), 400
    if not (1 <= label_col <= 4):
        return jsonify({"error": "label_col must be 1–4"}), 400

    stickers_raw = data.get("stickers")

    if stickers_raw is not None:
        # Multi-sticker batch path
        if len(stickers_raw) > 100:
            return jsonify({"error": "Maximum 100 stickers per batch"}), 400
        stickers = []
        for s in stickers_raw:
            dope = [
                (float(e["distance"]), float(e["adjustment"]), float(e.get("windage", 0.0)))
                for e in s.get("dope_data", [])
            ]
            stickers.append({"dope_data": dope, "wind_label": s.get("wind_label", "")})
        pdf_bytes = generate_dope_pdf_multi(
            stickers, label_row, label_col, session_name, offset_x, offset_y, adj_decimals,
        )
    else:
        # Single-sticker path (legacy + wind_label support)
        dope_data  = [
            (float(d["distance"]), float(d["adjustment"]), float(d.get("windage", 0.0)))
            for d in data.get("dope_data", [])
        ]
        wind_label = data.get("wind_label", "")
        if len(dope_data) > 10:
            return jsonify({"error": "Maximum 10 DOPE entries"}), 400
        pdf_bytes = generate_dope_pdf(
            dope_data, label_row, label_col, session_name, offset_x, offset_y,
            fill_sheet=fill_sheet, wind_label=wind_label, adj_decimals=adj_decimals,
        )

    filename = (session_name.replace(" ", "_") + ".pdf") if session_name else "dope-sticker.pdf"
    return send_file(io.BytesIO(pdf_bytes), mimetype="application/pdf",
                     as_attachment=True, download_name=filename)


# ── Ammo — read ───────────────────────────────────────────────────────────────

@bp.route("/api/ammo", methods=["GET"])
def get_ammo():
    return jsonify({"ammo": db.load_ammo()})


# ── Ammo — add ────────────────────────────────────────────────────────────────

@bp.route("/api/ammo", methods=["POST"])
@limiter.limit("20 per hour")
def add_ammo():
    banned = _check_banned()
    if banned:
        return banned

    entry = request.get_json(force=True)
    for field in ("caliber", "name", "velocity_fps", "bc_g1", "bc_g7"):
        if field not in entry:
            return jsonify({"error": f"Missing field: {field}"}), 400

    if db.ammo_exists(entry["caliber"], entry["name"]):
        return jsonify({"error": f"Ammo '{entry['name']}' already exists for caliber '{entry['caliber']}'"}), 409

    db.add_ammo({
        "caliber":      entry["caliber"],
        "name":         entry["name"],
        "velocity_fps": float(entry["velocity_fps"]),
        "bc_g1":        float(entry["bc_g1"]),
        "bc_g7":        float(entry["bc_g7"]),
    })
    return jsonify({"added": entry["name"]})


# ── Ammo — edit ───────────────────────────────────────────────────────────────

@bp.route("/api/ammo/<name>", methods=["PUT"])
@limiter.limit("20 per hour")
def edit_ammo(name: str):
    banned = _check_banned()
    if banned:
        return banned

    updates     = request.get_json(force=True)
    new_name    = updates.get("name", name)
    new_caliber = updates.get("caliber", "")

    if (new_name != name or new_caliber) and db.ammo_exists(new_caliber or name, new_name):
        return jsonify({"error": f"Ammo '{new_name}' already exists for that caliber"}), 409

    castable = {}
    for k, cast in (("caliber", str), ("name", str),
                    ("velocity_fps", float), ("bc_g1", float), ("bc_g7", float)):
        if k in updates:
            castable[k] = cast(updates[k])

    if not db.edit_ammo(name, castable):
        return jsonify({"error": "Not found or already deleted"}), 404

    return jsonify({"updated": new_name})


# ── Ammo — soft-delete ────────────────────────────────────────────────────────

@bp.route("/api/ammo/<name>", methods=["DELETE"])
@limiter.limit("10 per hour")
def delete_ammo(name: str):
    banned = _check_banned()
    if banned:
        return banned

    ip = _client_ip()
    if not db.soft_delete_ammo(name, ip):
        return jsonify({"error": "Not found or already deleted"}), 404

    return jsonify({"deleted": name, "by_ip": ip})


# ── Admin — bans ──────────────────────────────────────────────────────────────

@bp.route("/api/admin/bans", methods=["GET"])
def admin_list_bans():
    err = _require_admin()
    if err:
        return err
    return jsonify({"bans": db.list_bans()})


@bp.route("/api/admin/bans", methods=["POST"])
def admin_ban_ip():
    err = _require_admin()
    if err:
        return err
    data = request.get_json(force=True)
    ip = data.get("ip", "").strip()
    if not ip:
        return jsonify({"error": "ip required"}), 400
    db.ban_ip(ip, data.get("reason", ""))
    return jsonify({"banned": ip})


@bp.route("/api/admin/bans/<path:ip>", methods=["DELETE"])
def admin_unban_ip(ip: str):
    err = _require_admin()
    if err:
        return err
    if not db.unban_ip(ip):
        return jsonify({"error": "Not found"}), 404
    return jsonify({"unbanned": ip})


# ── Admin — deleted ammo ──────────────────────────────────────────────────────

@bp.route("/api/admin/deleted", methods=["GET"])
def admin_list_deleted():
    err = _require_admin()
    if err:
        return err
    return jsonify({"deleted": db.list_deleted()})


@bp.route("/api/admin/restore/<name>", methods=["POST"])
def admin_restore(name: str):
    err = _require_admin()
    if err:
        return err
    if not db.restore_ammo(name):
        return jsonify({"error": "Not found"}), 404
    return jsonify({"restored": name})
