# DOPE Sticker Calculator

A web-based ballistics calculator that generates color-coded scope adjustment stickers formatted for **Avery 8293** 1.5" round labels. Designed for NRL22 rimfire competition but supports any caliber from .22 LR through large-caliber precision rifle.

---

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Deployment](#deployment)
- [Configuration](#configuration)
- [Using the Web UI](#using-the-web-ui)
- [Ballistics Model](#ballistics-model)
- [PDF Output](#pdf-output)
- [Sessions (.dope files)](#sessions-dope-files)
- [API Reference](#api-reference)
- [Admin CLI](#admin-cli)
- [Security](#security)

---

## Overview

DOPE (Data Observed from Previous Engagements) is the shooter's record of actual scope adjustments at specific distances. This tool takes range-observed DOPE entries, corrects them for match-day environmental conditions, and outputs a ready-to-print PDF sticker that fits the eyepiece flip cap of a rifle scope.

### Workflow

1. Enter your ammunition's muzzle velocity and ballistic coefficient.
2. Enter at least 3 observed DOPE entries from range sessions (optionally with the temperature and elevation those entries were recorded at). There is no upper limit.
3. Enter match-day conditions (temperature, elevation, zero distance, scope height).
4. Select the output distances for the sticker (up to 10).
5. Calculate — the app bias-corrects the ballistic model using your observed data.
6. Select which distances to include, preview the sticker, and download the PDF.

---

## Features

| Feature | Detail |
|---------|--------|
| Ballistics engine | Point-mass G7 or G1 drag model with numerical integration |
| Environmental correction | ISA pressure lapse + temperature for air density |
| Bias-correction interpolation | Minimum 3 observed DOPE entries correct for rifle-specific factors |
| Sight height correction | Geometrically correct barrel-to-scope offset formula |
| Multi-caliber ammo DB | SQLite database, 26 calibers, ~124 factory loads |
| Ammo management | Add, edit, soft-delete with IP logging |
| Distance units | Yards or Meters (converted internally for ballistics) |
| Adjustment units | MRAD (mil) or MOA; MOA values rounded to nearest 0.25 click |
| In-browser sticker preview | Live circle preview before downloading |
| Fill entire sheet | Print all 20 Avery 8293 positions in one PDF |
| Quick-add distance presets | One-click buttons for 25-300 yd |
| Save/load sessions | Client-side `.dope` JSON files — no server state |
| localStorage persistence | Velocity, BC, conditions, unit prefs survive browser restarts |
| Rate limiting | 20 adds/hr, 10 deletes/hr per IP |
| IP banning | Banned IPs blocked from all mutation endpoints |
| Printer calibration | Per-axis offset nudge to correct systematic misalignment |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Python 3, Flask 3, Gunicorn |
| Ballistics | Custom numerical integrator (`app/ballistics.py`) |
| PDF | ReportLab, Liberation Sans Narrow Bold TTF |
| Database | SQLite via stdlib `sqlite3` |
| Rate limiting | Flask-Limiter |
| Frontend | Vanilla HTML5 / CSS3 / ES6 JavaScript |
| Reverse proxy | nginx (via NPM), TLS terminated upstream |
| Process management | systemd |

---

## Project Structure

```
/var/www/dope-calculator/
├── run.py                   # Gunicorn entry point
├── requirements.txt
├── dope-admin.py            # Admin CLI tool
├── app/
│   ├── factory.py           # Flask app factory, limiter init, DB init
│   ├── routes.py            # All API and page routes
│   ├── ballistics.py        # G1/G7 trajectory model, bias-correction
│   ├── pdf_generator.py     # ReportLab PDF output
│   └── database.py          # SQLite CRUD for ammo and IP bans
├── data/
│   ├── ammunition.csv       # Seed data (used for initial DB migration only)
│   └── dope.db              # Live SQLite database
├── templates/
│   └── index.html           # Single-page Jinja2 template
└── static/
    ├── favicon.svg
    ├── css/style.css
    └── js/app.js
```

---

## Deployment

The app runs on port 5000 behind nginx Proxy Manager (NPM). NPM handles TLS; the Flask app is HTTP-only.

### systemd service

```
/etc/systemd/system/dope-calculator.service
```

```ini
[Service]
User=svc-dope
Group=svc-dope
WorkingDirectory=/var/www/dope-calculator
Environment=HOME=/var/www/dope-calculator
Environment=DOPE_ADMIN_KEY=<key>
ExecStart=/var/www/dope-calculator/.venv/bin/gunicorn \
    --bind 0.0.0.0:5000 \
    --workers 2 \
    --access-logfile /var/log/dope-calculator/access.log \
    --error-logfile  /var/log/dope-calculator/error.log \
    --access-logformat '%(h)s %(l)s %(u)s %(t)s "%(r)s" %(s)s %(b)s "%(f)s" "%(a)s"' \
    run:app
```

### Service management

```bash
sudo systemctl start   dope-calculator
sudo systemctl stop    dope-calculator
sudo systemctl restart dope-calculator
sudo systemctl status  dope-calculator
```

### Logs

```bash
sudo tail -f /var/log/dope-calculator/access.log
sudo tail -f /var/log/dope-calculator/error.log
```

### Python environment

```bash
cd /var/www/dope-calculator
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

---

## Configuration

All runtime configuration lives in the systemd unit file.

| Environment variable | Default | Purpose |
|----------------------|---------|---------|
| `DOPE_ADMIN_KEY` | *(required)* | Bearer token for admin API endpoints |
| `DOPE_URL` | `http://localhost:5000` | Base URL used by `dope-admin.py` CLI |
| `HOME` | `/var/www/dope-calculator` | Required for Gunicorn control socket |

Retrieve the current admin key:

```bash
sudo grep DOPE_ADMIN_KEY /etc/systemd/system/dope-calculator.service
```

---

## Using the Web UI

### 1. Session

Give the session a name (used as the PDF filename). Save and load sessions as `.dope` files — these are plain JSON and portable between machines.

- **Distance Unit** — Yards or Meters. All input distances and presets use the selected unit. Switching units clears output distances and recalculates headers throughout the UI.
- **Adjustment Unit** — MRAD (mil) or MOA. DOPE entry fields, results, and sticker preview all reflect the selected unit. MOA values are rounded to the nearest 0.25 (one click).

### 2. Ammunition

Select a caliber from the dropdown to filter the load list. The selected load auto-fills velocity and BC. Override any value manually.

- **BC Model** — choose G7 (preferred for boat-tail projectiles) or G1 (use when only G1 BC is published).
- **Add Ammo to DB** — permanently adds a load to the SQLite database.
- **Edit Selected** — edit the currently selected load in place.
- **Delete Selected** — soft-deletes the load (hidden from the UI; recoverable via admin CLI).

### 3. Range DOPE Entries

Enter **at least 3** distance/adjustment pairs from actual range sessions — there is no upper limit. Optionally record the temperature and elevation the data was collected at — if left blank, match-day conditions are assumed for those entries. Distance and adjustment fields respect the unit selectors from the Session section.

### 4. Match-Day Conditions

| Field | Notes |
|-------|-------|
| Zero Distance | Distance at which the rifle is zeroed (yards) |
| Scope Height | Center of scope above bore centerline (inches). Default 1.5" |
| Temperature | Expected match-day temperature (°F) |
| Elevation | Match location elevation above sea level (ft) |

### 5. Output Distances

Click preset buttons (25 / 50 / 75 / 100 / 150 / 200 / 250 / 300, in the currently selected distance unit) or type a custom value. No upper limit on individual distances. Up to 10 distances per sticker.

### 6. Calculate

Click **Calculate DOPE**. Results appear as a table with the selected adjustment unit and a click count:

| Unit | Click size |
|------|-----------|
| MRAD | 0.1 mil per click |
| MOA | 0.25 MOA per click |

MOA adjustments are displayed rounded to the nearest 0.25 click. Uncheck any distances to exclude them from the sticker.

### 7. Generate Sticker PDF

- Click a cell in the Avery 8293 grid to choose which label position to print.
- Enable **Fill entire sheet** to populate all 20 positions (useful when you need multiple copies).
- Use **Printer Calibration Offset** after a test print to correct systematic horizontal or vertical misalignment.
- The **sticker preview** circle updates live as you check/uncheck distances.
- Click **Download PDF** — file is named after the session name if set.

---

## Ballistics Model

### Drag model

The engine uses a point-mass trajectory with numerical integration in 0.5-yard steps. Two standard reference projectiles are supported:

| Model | Use when |
|-------|----------|
| **G7** | Boat-tail / spitzer bullets (most modern rifle and match .22 LR loads) |
| **G1** | Flat-base bullets, or when only G1 BC is published |

Air density is corrected for altitude and temperature via the ISA pressure lapse rate:

```
density_ratio = (1 - 6.876e-6 * alt_ft)^5.2561 * (T_std / T_actual)
effective_BC  = published_BC / density_ratio
```

### Sight height correction

All elevation adjustments account for the scope-to-bore offset geometrically:

```
delta   = drop_d - (drop_z - h) * (d/z) - h
adj_mil = -delta / (d * 36/1000)
```

where `h` = scope height (inches), `z` = zero distance (yards), `d` = target distance (yards), and `drop_*` are bore-referenced drops from the numerical integrator. Verified: adjustment is exactly 0.0 at the zero distance.

### Bias-correction interpolation

Pure ballistic models do not account for actual rifle zero offset, worn crowns, suppressor shift, or BC deviations. The bias-correction approach isolates those factors:

1. For each observed DOPE entry, compute **residual = observed - model(range conditions)**.
2. Interpolate the residuals to the target distance.
3. Return **match-day model(target) + interpolated residual**.

The model is most accurate near the distances you actually shot, and degrades gracefully to pure ballistics outside that range.

---

## PDF Output

### Label specification

| Property | Value |
|----------|-------|
| Stock | Avery 8293 |
| Label shape | 1.5" diameter circle |
| Sheet layout | 4 columns x 5 rows = 20 labels |
| Top/bottom sheet margin to label edge | 0.75" |
| Left/right sheet margin to label edge | 0.50" |
| Column pitch | 2.0" center-to-center |
| Row pitch | 2.0" center-to-center |

### Sticker layout

```
  <- outer ---- center ---- outer ->

  +1.2  100 | 150  -2.1
  ----------+----------
  -3.8  200 | 250  -5.9
```

- Distances are **blue**, flush to the center divider.
- Positive adjustments are **green**, negative are **red**.
- Font size scales dynamically to fit all rows within the circle (Liberation Sans Narrow Bold).
- Up to 10 entries displayed as up to 5 rows of 2 columns.

---

## Sessions (.dope files)

Sessions are saved as JSON with a `.dope` extension and downloaded directly to the browser. No data is stored server-side.

```json
{
  "session_name": "Rifle 1 - Summer Match",
  "dist_unit": "yd",
  "adj_unit": "mrad",
  "ammo_name": "CCI Green Tag",
  "velocity_fps": 1070,
  "bc_g7": 0.067,
  "bc_g1": 0.131,
  "bc_model": "g7",
  "zero_yards": 50,
  "sight_height_in": 1.5,
  "temp_f": 85,
  "altitude_ft": 650,
  "range_temp_f": 72,
  "range_altitude_ft": 850,
  "dope_entries_raw": [
    { "distance": 50,  "adjustment": 0.0 },
    { "distance": 100, "adjustment": 2.9 },
    { "distance": 200, "adjustment": 9.1 }
  ],
  "output_distances": [50, 100, 150, 200, 250, 300]
}
```

`dist_unit` is `"yd"` or `"m"`. `adj_unit` is `"mrad"` or `"moa"`. `dope_entries_raw` stores distances and adjustments in the display units selected at save time.

---

## API Reference

### `GET /`
Returns the main application page.

---

### `POST /api/calculate`
Calculate MIL adjustments for a set of distances.

**Request body:**
```json
{
  "velocity_fps": 1070,
  "bc_model": "g7",
  "bc_g7": 0.067,
  "bc_g1": 0.131,
  "zero_yards": 50,
  "sight_height_in": 1.5,
  "altitude_ft": 650,
  "temp_f": 85,
  "dope_entries": [
    { "distance": 100, "adjustment": 2.9, "temp_f": 72, "altitude_ft": 850 }
  ],
  "output_distances": [50, 100, 150, 200, 250, 300]
}
```

`temp_f` and `altitude_ft` inside each `dope_entry` are optional — omit them to use match-day conditions for that entry.

**Response:**
```json
{ "results": { "50": 0.0, "100": 2.9, "150": 5.4, "200": 9.1, "250": 13.2, "300": 17.9 } }
```

---

### `POST /api/generate-pdf`
Generate and download a sticker PDF.

**Request body:**
```json
{
  "dope_data": [
    { "distance": 100, "adjustment": 2.9 },
    { "distance": 200, "adjustment": 9.1 }
  ],
  "label_row": 1,
  "label_col": 1,
  "session_name": "Rifle 1",
  "offset_x_in": 0.0,
  "offset_y_in": 0.0,
  "fill_sheet": false
}
```

`fill_sheet: true` prints the same sticker in all 20 positions. `label_row`/`label_col` are ignored when `fill_sheet` is true.

**Response:** `application/pdf` binary

---

### `GET /api/ammo`
Return all active ammo entries.

**Response:**
```json
{
  "ammo": [
    { "caliber": ".22 LR", "name": "CCI Green Tag", "velocity_fps": 1070.0, "bc_g1": 0.131, "bc_g7": 0.067 }
  ]
}
```

---

### `POST /api/ammo`
Add a new ammo entry. Rate limited to **20 per hour** per IP.

**Request body:**
```json
{ "caliber": ".22 LR", "name": "My Load", "velocity_fps": 1070, "bc_g1": 0.131, "bc_g7": 0.067 }
```

**Response:** `{ "added": "My Load" }` or `409` if name already exists.

---

### `PUT /api/ammo/<name>`
Edit an existing ammo entry. Rate limited to **20 per hour** per IP.

**Request body:** Any subset of `caliber`, `name`, `velocity_fps`, `bc_g1`, `bc_g7`.

**Response:** `{ "updated": "<new name>" }`

---

### `DELETE /api/ammo/<name>`
Soft-delete an ammo entry (hides from UI; recoverable). Records requester IP. Rate limited to **10 per hour** per IP.

**Response:** `{ "deleted": "<name>", "by_ip": "1.2.3.4" }`

---

### Admin endpoints

All admin endpoints require the header:
```
X-Admin-Key: <DOPE_ADMIN_KEY>
```

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/admin/bans` | List all banned IPs |
| `POST` | `/api/admin/bans` | Ban an IP — body: `{ "ip": "1.2.3.4", "reason": "..." }` |
| `DELETE` | `/api/admin/bans/<ip>` | Remove an IP ban |
| `GET` | `/api/admin/deleted` | List soft-deleted ammo entries |
| `POST` | `/api/admin/restore/<name>` | Restore a soft-deleted ammo entry |

---

## Admin CLI

`dope-admin.py` wraps the admin API. Requires `DOPE_ADMIN_KEY` in the environment.

```bash
export DOPE_ADMIN_KEY=$(sudo grep DOPE_ADMIN_KEY /etc/systemd/system/dope-calculator.service | cut -d= -f3)
```

### Commands

```bash
# IP bans
dope-admin.py bans list
dope-admin.py bans add <ip> [--reason "reason text"]
dope-admin.py bans remove <ip>

# Soft-deleted ammo
dope-admin.py deleted list
dope-admin.py deleted restore "<exact ammo name>"
```

Override the server URL if running from a remote machine:
```bash
DOPE_URL=https://dope.schwefel.net dope-admin.py bans list
```

Optional: add to `$PATH`:
```bash
sudo ln -s /var/www/dope-calculator/dope-admin.py /usr/local/bin/dope-admin
```

---

## Security

### Rate limiting

Mutation endpoints are rate-limited per IP using Flask-Limiter (in-memory; resets on service restart):

| Endpoint | Limit |
|----------|-------|
| `POST /api/ammo` | 20 / hour |
| `PUT /api/ammo/<name>` | 20 / hour |
| `DELETE /api/ammo/<name>` | 10 / hour |

### IP banning

Banned IPs receive `403 Forbidden` on all ammo mutation endpoints. Bans are stored in the SQLite database and survive service restarts. Manage via `dope-admin.py` or the admin API.

### Soft-delete audit trail

Deleted entries are never removed from the database. Each soft-deleted row records the requester's IP and a timestamp. Entries are recoverable via `dope-admin.py deleted restore`.

### Admin key rotation

```bash
NEW_KEY=$(python3 -c "import secrets; print(secrets.token_hex(32))")
sudo sed -i "s/DOPE_ADMIN_KEY=.*/DOPE_ADMIN_KEY=${NEW_KEY}/" /etc/systemd/system/dope-calculator.service
sudo systemctl daemon-reload && sudo systemctl restart dope-calculator
echo "New key: $NEW_KEY"
```
