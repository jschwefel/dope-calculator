"""
PDF generator for Avery 8293 (1.5" round labels, 20-up, 4x5 layout).
Produces a color-coded two-column DOPE sticker at a specified row/column.
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

LABEL_DIAM = 1.5 * inch
COLS = 4
ROWS = 5

# Avery 8293 geometry — derived from published sheet margins:
#   top/bottom: 0.75" to label edge  → center row 1 = 0.75 + 0.75 = 1.5"
#   left/right: 0.50" to label edge  → center col 1 = 0.50 + 0.75 = 1.25"
#   col pitch:  1.5" label + 0.50" gap = 2.0"   (4 cols × checks: right edge = 1.25+3×2.0+0.75 = 8.0", margin = 0.5" ✓)
#   row pitch:  1.5" label + 0.50" gap = 2.0"   (5 rows × checks: bottom edge = 1.5+4×2.0+0.75 = 10.25", margin = 0.75" ✓)
MARGIN_TOP = 1.5 * inch      # top edge to center of row 1
MARGIN_LEFT = 1.25 * inch    # left edge to center of col 1
COL_SPACING = 2.0 * inch
ROW_SPACING = 2.0 * inch

BLUE = HexColor("#1565C0")
RED = HexColor("#C62828")
GREEN = HexColor("#2E7D32")
BLACK = colors.black
WHITE = colors.white


def _label_center(
    row: int,
    col: int,
    offset_x_in: float = 0.0,
    offset_y_in: float = 0.0,
) -> tuple[float, float]:
    """
    Return (cx, cy) in points for 1-indexed row/col.
    ReportLab origin is bottom-left, so we flip y.
    offset_x_in / offset_y_in are calibration nudges in inches (+x = right, +y = down).
    """
    cx = MARGIN_LEFT + (col - 1) * COL_SPACING + offset_x_in * inch
    cy = PAGE_H - (MARGIN_TOP + (row - 1) * ROW_SPACING + offset_y_in * inch)
    return cx, cy


def generate_dope_pdf(
    dope_data: list[tuple[float, float]],
    label_row: int,
    label_col: int,
    session_name: str = "",
    offset_x_in: float = 0.0,
    offset_y_in: float = 0.0,
    fill_sheet: bool = False,
) -> bytes:
    """
    Generate a PDF with DOPE sticker(s).

    fill_sheet=False: single sticker at (label_row, label_col).
    fill_sheet=True:  same sticker in every position on the sheet.
    """
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(PAGE_W, PAGE_H))
    r = LABEL_DIAM / 2.0

    if fill_sheet:
        for row in range(1, ROWS + 1):
            for col in range(1, COLS + 1):
                cx, cy = _label_center(row, col, offset_x_in, offset_y_in)
                _draw_sticker_content(c, cx, cy, r, dope_data)
    else:
        cx, cy = _label_center(label_row, label_col, offset_x_in, offset_y_in)
        _draw_sticker_content(c, cx, cy, r, dope_data)

    c.save()
    return buf.getvalue()


def _fmt_adj(val: float) -> str:
    if val == 0.0:
        return "0.0"
    return f"{val:+.1f}"


def _adj_color(val: float) -> object:
    if val > 0:
        return GREEN
    if val < 0:
        return RED
    return BLACK


def _entry_str(dist: float, adj: float) -> tuple[str, str]:
    dist_str = str(int(dist)) if dist == int(dist) else f"{dist:.0f}"
    return dist_str, _fmt_adj(adj)


def _row_width(c: canvas.Canvas, left: tuple, right: tuple | None, size: float, gap: float) -> float:
    """Total width needed for the widest half-row at the given font size."""
    def half_w(entry):
        dist_str, adj_str = _entry_str(*entry)
        return (
            c.stringWidth(adj_str, _NARROW_BOLD, size)
            + gap
            + c.stringWidth(dist_str, _NARROW_BOLD, size)
        )
    w = half_w(left)
    if right is not None:
        w = max(w, half_w(right))
    return w


def _fit_font_size(
    c: canvas.Canvas,
    pairs: list,
    half_w_avail: float,
    row_h: float,
) -> float:
    """Return the largest font size where every row fits within half_w_avail."""
    gap = 0.04 * inch
    max_size = min(row_h * 0.72, 11.0)
    size = max_size
    while size >= 5.0:
        fits = all(
            _row_width(c, left, right, size, gap) <= half_w_avail
            for left, right in pairs
        )
        if fits:
            return size
        size -= 0.25
    return 5.0


def _draw_sticker_content(
    c: canvas.Canvas,
    cx: float,
    cy: float,
    r: float,
    dope_data: list[tuple[float, float]],
) -> None:
    """Draw the two-column DOPE table centered inside the circle."""
    pairs: list[tuple[tuple, tuple | None]] = []
    for i in range(0, min(len(dope_data), 10), 2):
        left = dope_data[i]
        right = dope_data[i + 1] if i + 1 < len(dope_data) else None
        pairs.append((left, right))

    n_rows = len(pairs)
    if n_rows == 0:
        return

    usable_h = r * 1.72
    row_h = usable_h / n_rows
    half_w_avail = r * 0.88

    font_size = _fit_font_size(c, pairs, half_w_avail, row_h)
    gap = 0.04 * inch

    # Center the table block vertically in the circle
    table_h = n_rows * row_h
    top_y = cy + table_h / 2.0

    # Center divider
    c.setStrokeColor(BLACK)
    c.setLineWidth(0.5)
    c.line(cx, top_y, cx, top_y - table_h)

    # Row separators
    for i in range(1, n_rows):
        sep_y = top_y - i * row_h
        c.line(cx - r * 0.88, sep_y, cx + r * 0.88, sep_y)

    # Draw rows
    for i, (left_entry, right_entry) in enumerate(pairs):
        row_top = top_y - i * row_h
        text_y = row_top - row_h / 2.0 - font_size * 0.32

        _draw_half_left(c, cx, text_y, font_size, gap, left_entry)
        if right_entry is not None:
            _draw_half_right(c, cx, text_y, font_size, gap, right_entry)


def _draw_half_left(
    c: canvas.Canvas,
    cx: float, y: float,
    size: float, gap: float,
    entry: tuple[float, float],
) -> None:
    """Left half: [adj] [dist] — distance flush to center, adj on outer edge."""
    dist_str, adj_str = _entry_str(*entry)
    dist, adj = entry

    dist_w = c.stringWidth(dist_str, _NARROW_BOLD, size)
    adj_w  = c.stringWidth(adj_str,  _NARROW_BOLD, size)

    dist_x = cx - gap - dist_w
    adj_x  = dist_x - gap - adj_w

    c.setFont(_NARROW_BOLD, size)
    c.setFillColor(BLUE)
    c.drawString(dist_x, y, dist_str)

    c.setFillColor(_adj_color(adj))
    c.drawString(adj_x, y, adj_str)


def _draw_half_right(
    c: canvas.Canvas,
    cx: float, y: float,
    size: float, gap: float,
    entry: tuple[float, float],
) -> None:
    """Right half: [dist] [adj] — distance flush to center, adj on outer edge."""
    dist_str, adj_str = _entry_str(*entry)
    dist, adj = entry

    dist_w = c.stringWidth(dist_str, _NARROW_BOLD, size)

    dist_x = cx + gap
    adj_x  = dist_x + dist_w + gap

    c.setFont(_NARROW_BOLD, size)
    c.setFillColor(BLUE)
    c.drawString(dist_x, y, dist_str)

    c.setFillColor(_adj_color(adj))
    c.drawString(adj_x, y, adj_str)
