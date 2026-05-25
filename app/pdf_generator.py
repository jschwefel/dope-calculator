# Copyright (C) 2026 Jason M. Schwefel
#
# This file is part of DOPE Sticker Calculator.
#
# DOPE Sticker Calculator is free software: you can redistribute it and/or
# modify it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# DOPE Sticker Calculator is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with DOPE Sticker Calculator.  If not, see <https://www.gnu.org/licenses/>.

"""
PDF generator for Avery 8293 (1.5" round labels, 20-up, 4x5 layout).

Without wind: two-column layout (adj|dist || dist|adj).
With wind:    same two-column layout with a windage sub-line below each
              elevation row, plus a wind-condition label at the top.
"""

import io
from reportlab.pdfgen import canvas
from reportlab.lib.units import inch
from reportlab.lib import colors
from reportlab.lib.colors import HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

_NARROW_BOLD = "LiberationSansNarrow-Bold"
_NARROW_REG  = "LiberationSansNarrow-Regular"

pdfmetrics.registerFont(TTFont(
    _NARROW_BOLD,
    "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Bold.ttf",
))
pdfmetrics.registerFont(TTFont(
    _NARROW_REG,
    "/usr/share/fonts/truetype/liberation/LiberationSansNarrow-Regular.ttf",
))


# Avery 8293 sheet geometry (letter paper, inches)
PAGE_W = 8.5 * inch
PAGE_H = 11.0 * inch

LABEL_DIAM  = 1.5 * inch
COLS        = 4
ROWS        = 5

MARGIN_TOP  = 1.5  * inch   # top edge to center of row 1
MARGIN_LEFT = 1.25 * inch   # left edge to center of col 1
COL_SPACING = 2.0  * inch
ROW_SPACING = 2.0  * inch

BLUE  = HexColor("#1565C0")
RED   = HexColor("#C62828")
GREEN = HexColor("#2E7D32")
AMBER = HexColor("#E65100")   # windage
GRAY  = HexColor("#666666")   # wind label
BLACK = colors.black
WHITE = colors.white


def _label_center(row, col, offset_x_in=0.0, offset_y_in=0.0):
    cx = MARGIN_LEFT + (col - 1) * COL_SPACING + offset_x_in * inch
    cy = PAGE_H - (MARGIN_TOP + (row - 1) * ROW_SPACING + offset_y_in * inch)
    return cx, cy


def _parse_entry(entry) -> tuple[float, float, float]:
    """Accept (dist, adj) or (dist, adj, wind) tuples."""
    if len(entry) >= 3:
        return float(entry[0]), float(entry[1]), float(entry[2])
    return float(entry[0]), float(entry[1]), 0.0


def generate_dope_pdf(
    dope_data: list,
    label_row: int,
    label_col: int,
    session_name: str = "",
    offset_x_in: float = 0.0,
    offset_y_in: float = 0.0,
    fill_sheet: bool = False,
    wind_label: str = "",
    adj_decimals: int = 1,
) -> bytes:
    """
    Generate a PDF with DOPE sticker(s).

    fill_sheet=False: single sticker at (label_row, label_col).
    fill_sheet=True:  same sticker in every position on the sheet.
    wind_label:       optional condition text drawn at top of each sticker.
    adj_decimals:     decimal places for adjustments (1 for MRAD, 2 for MOA).
    """
    buf = io.BytesIO()
    c   = canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    r   = LABEL_DIAM / 2.0

    if fill_sheet:
        for row in range(1, ROWS + 1):
            for col in range(1, COLS + 1):
                cx, cy = _label_center(row, col, offset_x_in, offset_y_in)
                _draw_sticker_content(c, cx, cy, r, dope_data, wind_label, adj_decimals)
    else:
        cx, cy = _label_center(label_row, label_col, offset_x_in, offset_y_in)
        _draw_sticker_content(c, cx, cy, r, dope_data, wind_label, adj_decimals)

    c.save()
    return buf.getvalue()


def generate_dope_pdf_multi(
    stickers: list[dict],
    start_row: int,
    start_col: int,
    session_name: str = "",
    offset_x_in: float = 0.0,
    offset_y_in: float = 0.0,
    adj_decimals: int = 1,
) -> bytes:
    """
    Generate a multi-page PDF with one sticker per wind condition.
    Stickers are placed starting at (start_row, start_col), filling
    columns then rows, adding a new page when the sheet is full.

    Each sticker dict: {"dope_data": [(dist, adj, wind), ...], "wind_label": str}
    adj_decimals: decimal places for adjustments (1 for MRAD, 2 for MOA).
    """
    buf  = io.BytesIO()
    c    = canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    r    = LABEL_DIAM / 2.0
    row  = start_row
    col  = start_col

    for sticker in stickers:
        cx, cy = _label_center(row, col, offset_x_in, offset_y_in)
        _draw_sticker_content(
            c, cx, cy, r,
            sticker.get("dope_data", []),
            sticker.get("wind_label", ""),
            adj_decimals,
        )
        col += 1
        if col > COLS:
            col = 1
            row += 1
            if row > ROWS:
                row = 1
                c.showPage()

    c.save()
    return buf.getvalue()


# ── Formatting helpers ────────────────────────────────────────────────────────

def _fmt_adj(val: float, decimals: int = 1) -> str:
    if val == 0.0:
        return f"0.{'0' * decimals}"
    return f"{val:+.{decimals}f}"


def _fmt_wind(val: float, decimals: int = 1) -> str:
    """Windage string: '>0.5' (dial right) or '<0.5' (dial left)."""
    if abs(val) < 0.05:
        return ""
    arrow = ">" if val > 0 else "<"
    return f"{arrow}{abs(val):.{decimals}f}"


def _adj_color(val: float):
    if val > 0:  return GREEN
    if val < 0:  return RED
    return BLACK


def _entry_str(dist: float, adj: float, decimals: int = 1) -> tuple[str, str]:
    dist_str = str(int(dist)) if dist == int(dist) else f"{dist:.0f}"
    return dist_str, _fmt_adj(adj, decimals)


# ── Font-fit helpers ──────────────────────────────────────────────────────────

def _row_width(c, left, right, size, gap, decimals: int = 1):
    def half_w(entry):
        dist_str, adj_str = _entry_str(entry[0], entry[1], decimals)
        return (c.stringWidth(adj_str, _NARROW_BOLD, size)
                + gap
                + c.stringWidth(dist_str, _NARROW_BOLD, size))
    w = half_w(left)
    if right is not None:
        w = max(w, half_w(right))
    return w


def _fit_font_size(c, pairs, half_w_avail, row_h, has_wind=False, decimals: int = 1):
    gap     = 0.04 * inch
    size_cap = 9.5 if has_wind else 11.0
    max_size = min(row_h * 0.72, size_cap)
    size = max_size
    while size >= 5.0:
        if all(_row_width(c, left, right, size, gap, decimals) <= half_w_avail
               for left, right in pairs):
            return size
        size -= 0.25
    return 5.0


# ── Sticker drawing ───────────────────────────────────────────────────────────

def _draw_sticker_content(c, cx, cy, r, dope_data, wind_label="", adj_decimals: int = 1):
    entries = [_parse_entry(e) for e in dope_data[:8]]
    if not entries:
        return

    has_wind = any(abs(e[2]) >= 0.05 for e in entries)

    # Tighter margins: use more of the circle's vertical space
    usable_h    = r * 1.82
    label_gap   = 0.0
    if wind_label:
        label_size = min(6.0, r * 0.16)
        label_gap  = label_size * 1.6        # reserve space at top for label
        usable_h  -= label_gap

    # Build pairs list (using first two values only for width calculation)
    pairs = []
    for i in range(0, len(entries), 2):
        left  = entries[i]
        right = entries[i + 1] if i + 1 < len(entries) else None
        pairs.append((left, right))

    n_rows       = len(pairs)
    row_h        = usable_h / n_rows
    half_w_avail = r * 0.88

    font_size = _fit_font_size(c, pairs, half_w_avail, row_h, has_wind, adj_decimals)
    gap       = 0.04 * inch
    wind_size = max(font_size * 0.70, 5.0)

    # Row-height accounting: each row must fit main line + wind sub-line when present
    # Shift table block down by label_gap so it doesn't overlap the wind label
    table_h  = n_rows * row_h
    top_y    = cy + table_h / 2.0 - label_gap / 2.0

    # Wind label at top of circle (above table)
    if wind_label:
        c.setFont(_NARROW_REG, label_size)
        c.setFillColor(GRAY)
        lw = c.stringWidth(wind_label, _NARROW_REG, label_size)
        c.drawString(cx - lw / 2, top_y + label_gap * 0.35, wind_label)

    # Center divider
    c.setStrokeColor(BLACK)
    c.setLineWidth(0.5)
    c.line(cx, top_y, cx, top_y - table_h)

    # Row separators
    for i in range(1, n_rows):
        sep_y = top_y - i * row_h
        c.line(cx - half_w_avail, sep_y, cx + half_w_avail, sep_y)

    # Draw rows
    for i, (left_entry, right_entry) in enumerate(pairs):
        row_top = top_y - i * row_h
        # When wind sub-line present, shift main text slightly up within the row
        if has_wind:
            text_y = row_top - row_h * 0.38
        else:
            text_y = row_top - row_h / 2.0 - font_size * 0.32

        _draw_half_left(c, cx, text_y, font_size, gap, left_entry, wind_size, has_wind, adj_decimals)
        if right_entry is not None:
            _draw_half_right(c, cx, text_y, font_size, gap, right_entry, wind_size, has_wind, adj_decimals)


def _draw_half_left(c, cx, y, size, gap, entry, wind_size, has_wind, adj_decimals: int = 1):
    """Left half: [adj] [dist] — distance flush to center, adj on outer edge."""
    dist, adj, wind = entry
    dist_str, adj_str = _entry_str(dist, adj, adj_decimals)

    dist_w = c.stringWidth(dist_str, _NARROW_BOLD, size)
    adj_w  = c.stringWidth(adj_str,  _NARROW_BOLD, size)
    dist_x = cx - gap - dist_w
    adj_x  = dist_x - gap - adj_w

    c.setFont(_NARROW_BOLD, size)
    c.setFillColor(BLUE)
    c.drawString(dist_x, y, dist_str)
    c.setFillColor(_adj_color(adj))
    c.drawString(adj_x, y, adj_str)

    if has_wind:
        wind_str = _fmt_wind(wind, adj_decimals)
        if wind_str:
            wind_y = y - size * 0.88
            c.setFont(_NARROW_BOLD, wind_size)
            c.setFillColor(AMBER)
            c.drawString(adj_x, wind_y, wind_str)


def _draw_half_right(c, cx, y, size, gap, entry, wind_size, has_wind, adj_decimals: int = 1):
    """Right half: [dist] [adj] — distance flush to center, adj on outer edge."""
    dist, adj, wind = entry
    dist_str, adj_str = _entry_str(dist, adj, adj_decimals)

    dist_w = c.stringWidth(dist_str, _NARROW_BOLD, size)
    dist_x = cx + gap
    adj_x  = dist_x + dist_w + gap

    c.setFont(_NARROW_BOLD, size)
    c.setFillColor(BLUE)
    c.drawString(dist_x, y, dist_str)
    c.setFillColor(_adj_color(adj))
    c.drawString(adj_x, y, adj_str)

    if has_wind:
        wind_str = _fmt_wind(wind, adj_decimals)
        if wind_str:
            wind_y = y - size * 0.88
            c.setFont(_NARROW_BOLD, wind_size)
            c.setFillColor(AMBER)
            c.drawString(adj_x, wind_y, wind_str)
