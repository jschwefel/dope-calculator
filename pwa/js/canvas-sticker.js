/**
 * Canvas sticker renderer — port of app/pdf_generator.py _draw_sticker_content().
 *
 * Coordinate system difference: ReportLab origin is bottom-left (y up);
 * Canvas origin is top-left (y down). All vertical offsets are negated.
 *
 * Scale: r_pdf = 0.75 * 72 = 54 pt. scale = r_canvas / 54 converts PDF
 * point measurements to canvas pixels.
 */

const COLORS = {
    BLUE:  '#1565C0',
    RED:   '#C62828',
    GREEN: '#2E7D32',
    AMBER: '#E65100',
    GRAY:  '#666666',
    BLACK: '#000000',
};

const FONT_BOLD = sz => `700 ${sz}px "Barlow Condensed", "Arial Narrow", sans-serif`;
const FONT_REG  = sz => `normal ${sz}px "Barlow Condensed", "Arial Narrow", sans-serif`;

export async function loadFonts() {
    await Promise.all([
        document.fonts.load('700 12px "Barlow Condensed"'),
        document.fonts.load('normal 12px "Barlow Condensed"'),
    ]);
}

function fmtAdj(val, decimals = 1) {
    const v = Number(val);
    if (v === 0) return '0.' + '0'.repeat(decimals);
    return (v > 0 ? '+' : '') + v.toFixed(decimals);
}

function fmtWind(val, decimals = 1) {
    const v = Number(val);
    if (Math.abs(v) < 0.05) return '';
    return (v > 0 ? '>' : '<') + Math.abs(v).toFixed(decimals);
}

function adjColor(val) {
    if (val > 0) return COLORS.GREEN;
    if (val < 0) return COLORS.RED;
    return COLORS.BLACK;
}

function entryStr(dist, adj, decimals = 1) {
    const d = Number(dist);
    const dStr = (d === Math.floor(d)) ? String(Math.round(d)) : d.toFixed(0);
    return [dStr, fmtAdj(adj, decimals)];
}

function rowWidth(ctx, left, right, fontSize, gap, decimals) {
    ctx.font = FONT_BOLD(fontSize);
    function halfW(entry) {
        const [dStr, aStr] = entryStr(entry.dist, entry.adj, decimals);
        return ctx.measureText(aStr).width + gap + ctx.measureText(dStr).width;
    }
    let w = halfW(left);
    if (right !== null) w = Math.max(w, halfW(right));
    return w;
}

function fitFontSize(ctx, pairs, halfWAvail, rowH, hasWind, scale, decimals) {
    const gap     = 2.88 * scale;          // 0.04 inch * 72 pt/inch
    const sizeCap = (hasWind ? 9.5 : 11.0) * scale;
    const step    = 0.25 * scale;
    let size      = Math.min(rowH * 0.72, sizeCap);

    while (size >= 5.0 * scale) {
        const fits = pairs.every(([left, right]) =>
            rowWidth(ctx, left, right, size, gap, decimals) <= halfWAvail
        );
        if (fits) return size;
        size -= step;
    }
    return 5.0 * scale;
}

function parseEntries(dopeData) {
    return (Array.isArray(dopeData) ? dopeData : []).slice(0, 10).map(e => {
        if (Array.isArray(e)) {
            return { dist: Number(e[0]), adj: Number(e[1]), wind: Number(e[2] ?? 0) };
        }
        return {
            dist: Number(e.distance  ?? e.dist),
            adj:  Number(e.adjustment ?? e.adj),
            wind: Number(e.windage   ?? e.wind ?? 0),
        };
    });
}

export function drawSticker(canvas, dopeData, windLabel = '', adjDecimals = 1) {
    const ctx = canvas.getContext('2d');
    const W   = canvas.width;
    const H   = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // White background for print
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(W / 2, H / 2, Math.min(W, H) / 2, 0, Math.PI * 2);
    ctx.fill();

    const cx = W / 2;
    const cy = H / 2;
    const r  = Math.min(W, H) / 2;
    // PDF r = 54 pt; scale converts PDF pt → canvas px
    const scale = r / 54.0;

    const entries = parseEntries(dopeData);
    if (entries.length === 0) return;

    const hasWind = entries.some(e => Math.abs(e.wind) >= 0.05);

    let usableH  = r * 1.82;
    let labelGap = 0;
    let labelSize = 0;

    if (windLabel) {
        labelSize = Math.min(6.0 * scale, r * 0.16);
        labelGap  = labelSize * 1.6;
        usableH  -= labelGap;
    }

    const pairs = [];
    for (let i = 0; i < entries.length; i += 2) {
        pairs.push([entries[i], i + 1 < entries.length ? entries[i + 1] : null]);
    }

    const nRows      = pairs.length;
    const rowH       = usableH / nRows;
    const halfWAvail = r * 0.88;
    const gap        = 2.88 * scale;

    const fontSize = fitFontSize(ctx, pairs, halfWAvail, rowH, hasWind, scale, adjDecimals);
    const windSize = Math.max(fontSize * 0.70, 5.0 * scale);

    const tableH = nRows * rowH;
    // topY: visual top of table (smaller y = visually higher in Canvas)
    // When labelGap > 0, table shifts down by labelGap/2 to make room above for wind label
    const topY = cy - tableH / 2 + labelGap / 2;

    ctx.textBaseline = 'alphabetic';

    // Wind label above table
    if (windLabel) {
        ctx.font      = FONT_REG(labelSize);
        ctx.fillStyle = COLORS.GRAY;
        const lw      = ctx.measureText(windLabel).width;
        ctx.fillText(windLabel, cx - lw / 2, topY - labelGap * 0.35);
    }

    // Center divider
    ctx.strokeStyle = COLORS.BLACK;
    ctx.lineWidth   = 0.5 * scale;
    ctx.beginPath();
    ctx.moveTo(cx, topY);
    ctx.lineTo(cx, topY + tableH);
    ctx.stroke();

    // Row separators
    for (let i = 1; i < nRows; i++) {
        const sepY = topY + i * rowH;
        ctx.beginPath();
        ctx.moveTo(cx - halfWAvail, sepY);
        ctx.lineTo(cx + halfWAvail, sepY);
        ctx.stroke();
    }

    // Draw rows
    for (let i = 0; i < pairs.length; i++) {
        const [leftEntry, rightEntry] = pairs[i];
        const rowTop = topY + i * rowH;

        // textY = baseline y for main text in this row
        // has_wind: 38% from top of row; no wind: center + slight downward baseline offset
        const textY = hasWind
            ? rowTop + rowH * 0.38
            : rowTop + rowH / 2.0 + fontSize * 0.32;

        _drawHalfLeft(ctx, cx, textY, fontSize, gap, leftEntry, windSize, hasWind, adjDecimals);
        if (rightEntry !== null) {
            _drawHalfRight(ctx, cx, textY, fontSize, gap, rightEntry, windSize, hasWind, adjDecimals);
        }
    }
}

function _drawHalfLeft(ctx, cx, y, size, gap, entry, windSize, hasWind, adjDecimals) {
    const { dist, adj, wind } = entry;
    const [dStr, aStr] = entryStr(dist, adj, adjDecimals);
    ctx.font = FONT_BOLD(size);

    const distW = ctx.measureText(dStr).width;
    const adjW  = ctx.measureText(aStr).width;
    const distX = cx - gap - distW;
    const adjX  = distX - gap - adjW;

    ctx.fillStyle = COLORS.BLUE;
    ctx.fillText(dStr, distX, y);
    ctx.fillStyle = adjColor(adj);
    ctx.fillText(aStr, adjX, y);

    if (hasWind) {
        const wStr = fmtWind(wind, adjDecimals);
        if (wStr) {
            const windY = y + size * 0.88;
            ctx.font      = FONT_BOLD(windSize);
            ctx.fillStyle = COLORS.AMBER;
            ctx.fillText(wStr, adjX, windY);
        }
    }
}

function _drawHalfRight(ctx, cx, y, size, gap, entry, windSize, hasWind, adjDecimals) {
    const { dist, adj, wind } = entry;
    const [dStr, aStr] = entryStr(dist, adj, adjDecimals);
    ctx.font = FONT_BOLD(size);

    const distW = ctx.measureText(dStr).width;
    const distX = cx + gap;
    const adjX  = distX + distW + gap;

    ctx.fillStyle = COLORS.BLUE;
    ctx.fillText(dStr, distX, y);
    ctx.fillStyle = adjColor(adj);
    ctx.fillText(aStr, adjX, y);

    if (hasWind) {
        const wStr = fmtWind(wind, adjDecimals);
        if (wStr) {
            const windY = y + size * 0.88;
            ctx.font      = FONT_BOLD(windSize);
            ctx.fillStyle = COLORS.AMBER;
            ctx.fillText(wStr, adjX, windY);
        }
    }
}
