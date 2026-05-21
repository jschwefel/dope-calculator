/**
 * NRL22 DOPE Calculator — frontend logic
 */

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
    outputDistances:   [],      // in current display unit
    calculatedResults: {},      // display_dist_str -> { elevation, windage } in display units
    distUnit:          'yd',    // 'yd' | 'm'
    adjUnit:           'mrad',  // 'mrad' | 'moa'
    windConditions:    [],      // [{ speed, unit, angle }]
    lastCalcPayload:   null,    // base calculate payload (no wind) for batch re-use
};

// ── Conversion ────────────────────────────────────────────────────────────────
const YD_PER_M    = 1.093613;
const MOA_PER_MIL = 3.43775;

function toYards(v)  { return state.distUnit === 'm' ? v * YD_PER_M : v; }
function toMils(v)   { return state.adjUnit  === 'moa' ? v / MOA_PER_MIL : v; }
function fromMils(v) { return state.adjUnit  === 'moa' ? v * MOA_PER_MIL : v; }

function distLabel()   { return state.distUnit === 'm'   ? 'm'   : 'yd'; }
function adjLabel()    { return state.adjUnit  === 'moa' ? 'MOA' : 'mil'; }
function clickValue()  { return state.adjUnit  === 'moa' ? 0.25  : 0.1; }
function adjDecimals() { return state.adjUnit  === 'moa' ? 2     : 1; }

function roundToClick(v) {
    const cv = clickValue();
    return Math.round(v / cv) * cv;
}

function fmtAdj(v) {
    const r = roundToClick(v);
    if (r === 0) return '0.' + '0'.repeat(adjDecimals());
    return (r > 0 ? '+' : '') + r.toFixed(adjDecimals());
}

function adjClass(v) {
    const r = roundToClick(v);
    if (r > 0) return 'adj-pos';
    if (r < 0) return 'adj-neg';
    return 'adj-zero';
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function toast(msg, type = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast${type ? ' ' + type : ''}`;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Apply units — update all labels across the page ───────────────────────────
function applyUnits() {
    const dl = distLabel();
    const al = adjLabel();
    const cv = clickValue();

    $('dope-dist-header').textContent         = `Distance (${dl})`;
    $('dope-adj-header').textContent          = `Adjustment (${al})`;
    $('zero-yards-label').textContent         = `Zero Distance (${dl})`;
    $('results-dist-header').textContent      = `Distance (${dl})`;
    $('results-adj-header').textContent       = `Adjustment (${al})`;
    $('results-clicks-header').textContent    = `Clicks (${cv} ${al})`;
    $('results-windage-header').textContent   = `Windage (${al})`;
    $('new-distance').placeholder             = `Custom distance (${dl})`;

    document.querySelectorAll('.dist-chip span.dist-blue').forEach(el => {
        const d = el.dataset.rawDist;
        if (d !== undefined) el.textContent = `${d} ${dl}`;
    });
}

// ── Unit selectors ─────────────────────────────────────────────────────────────
$('dist-unit').addEventListener('change', function () {
    state.distUnit = this.value;
    state.outputDistances = [];
    state.calculatedResults = {};
    renderDistances();
    $('results-table').classList.add('hidden');
    updateStickerPreview();
    applyUnits();
    lsSave();
    toast(`Distances now in ${distLabel()}`, 'success');
});

$('adj-unit').addEventListener('change', function () {
    state.adjUnit = this.value;
    state.calculatedResults = {};
    $('results-table').classList.add('hidden');
    updateStickerPreview();
    applyUnits();
    lsSave();
    toast(`Adjustments now in ${adjLabel()}`, 'success');
});

// ── localStorage persistence ──────────────────────────────────────────────────
const LS_FIELDS = ['velocity-fps', 'bc-g7', 'bc-g1', 'bc-model',
                   'zero-yards', 'sight-height-in', 'temp-f', 'altitude-ft',
                   'dist-unit', 'adj-unit', 'wind-speed', 'wind-angle', 'wind-unit'];

function lsSave() {
    LS_FIELDS.forEach(id => {
        const el = $(id);
        if (el) localStorage.setItem('dope_' + id, el.value);
    });
}

function lsRestore() {
    LS_FIELDS.forEach(id => {
        const saved = localStorage.getItem('dope_' + id);
        const el = $(id);
        if (saved !== null && el) el.value = saved;
    });
    state.distUnit = $('dist-unit').value;
    state.adjUnit  = $('adj-unit').value;
    _applyBcModel($('bc-model').value);
    setCompassAngle(parseInt($('wind-angle').value) || 0);
    applyUnits();
}

LS_FIELDS.forEach(id => {
    const el = $(id);
    if (el) el.addEventListener('change', lsSave);
});

// ── BC model selector ─────────────────────────────────────────────────────────
function _applyBcModel(model) {
    $('field-bc-g7').classList.toggle('hidden', model !== 'g7');
    $('field-bc-g1').classList.toggle('hidden', model !== 'g1');
}

$('bc-model').addEventListener('change', function () {
    _applyBcModel(this.value);
    lsSave();
});

// ── Ammo selector ─────────────────────────────────────────────────────────────
function filterAmmoByCAliber(caliber) {
    const sel = $('ammo-select');
    let firstVisible = null;
    [...sel.options].forEach(opt => {
        const show = opt.dataset.caliber === caliber;
        opt.hidden = !show;
        if (show && !firstVisible) firstVisible = opt;
    });
    if (firstVisible) {
        sel.value = firstVisible.value;
        sel.dispatchEvent(new Event('change'));
    }
}

$('caliber-select').addEventListener('change', function () {
    filterAmmoByCAliber(this.value);
});

$('ammo-select').addEventListener('change', function () {
    const opt = this.selectedOptions[0];
    if (opt) {
        $('velocity-fps').value = opt.dataset.velocity;
        $('bc-g7').value = opt.dataset.bcg7;
        $('bc-g1').value = opt.dataset.bcg1;
        lsSave();
    }
});

filterAmmoByCAliber($('caliber-select').value);

// ── Add ammo ──────────────────────────────────────────────────────────────────
$('btn-show-add-ammo').addEventListener('click', () => {
    $('add-ammo-form').classList.toggle('hidden');
    $('edit-ammo-form').classList.add('hidden');
});

$('btn-add-ammo').addEventListener('click', async () => {
    const payload = {
        caliber:      $('new-ammo-caliber').value.trim(),
        name:         $('new-ammo-name').value.trim(),
        velocity_fps: parseFloat($('new-ammo-vel').value),
        bc_g1:        parseFloat($('new-ammo-bcg1').value),
        bc_g7:        parseFloat($('new-ammo-bcg7').value),
    };
    if (!payload.caliber) { toast('Enter caliber', 'error'); return; }
    if (!payload.name)    { toast('Enter ammo name', 'error'); return; }
    const res = await fetch('/api/ammo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) { toast(`Added: ${data.added}`, 'success'); location.reload(); }
    else        { toast(data.error || 'Error adding ammo', 'error'); }
});

// ── Edit ammo ─────────────────────────────────────────────────────────────────
let _editingOriginalName = null;

$('btn-edit-ammo').addEventListener('click', () => {
    const opt = $('ammo-select').selectedOptions[0];
    if (!opt) { toast('Select a load to edit', 'error'); return; }
    _editingOriginalName = opt.value;
    $('edit-ammo-caliber').value = opt.dataset.caliber;
    $('edit-ammo-name').value    = opt.value;
    $('edit-ammo-vel').value     = opt.dataset.velocity;
    $('edit-ammo-bcg1').value    = opt.dataset.bcg1;
    $('edit-ammo-bcg7').value    = opt.dataset.bcg7;
    $('edit-ammo-form').classList.remove('hidden');
    $('add-ammo-form').classList.add('hidden');
});

$('btn-cancel-edit-ammo').addEventListener('click', () => {
    $('edit-ammo-form').classList.add('hidden');
    _editingOriginalName = null;
});

$('btn-save-edit-ammo').addEventListener('click', async () => {
    if (!_editingOriginalName) return;
    const payload = {
        caliber:      $('edit-ammo-caliber').value.trim(),
        name:         $('edit-ammo-name').value.trim(),
        velocity_fps: parseFloat($('edit-ammo-vel').value),
        bc_g1:        parseFloat($('edit-ammo-bcg1').value),
        bc_g7:        parseFloat($('edit-ammo-bcg7').value),
    };
    if (!payload.caliber || !payload.name) { toast('Caliber and name required', 'error'); return; }
    const res = await fetch(`/api/ammo/${encodeURIComponent(_editingOriginalName)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (res.ok) { toast(`Updated: ${data.updated}`, 'success'); location.reload(); }
    else        { toast(data.error || 'Error updating ammo', 'error'); }
});

// ── Delete ammo ───────────────────────────────────────────────────────────────
$('btn-show-delete-ammo').addEventListener('click', async () => {
    const name = $('ammo-select').value;
    if (!name) { toast('Select ammo to delete', 'error'); return; }
    if (!confirm(`Delete "${name}" from database?`)) return;
    const res = await fetch(`/api/ammo/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const data = await res.json();
    if (res.ok) { toast(`Deleted: ${name}`, 'success'); location.reload(); }
    else        { toast(data.error || 'Error deleting ammo', 'error'); }
});

// ── DOPE entries ──────────────────────────────────────────────────────────────
['', '', ''].forEach(() => $('dope-entries').appendChild(buildDopeRow()));

$('btn-add-dope').addEventListener('click', () => {
    $('dope-entries').appendChild(buildDopeRow());
});

$('dope-entries').addEventListener('click', e => {
    if (e.target.classList.contains('btn-remove-dope'))
        e.target.closest('.dope-row').remove();
});

function buildDopeRow(dist = '', adj = '') {
    const div = document.createElement('div');
    div.className = 'dope-row';
    div.innerHTML = `
        <div class="field"><input type="number" class="dope-dist" placeholder="e.g. 100" min="1" step="1" value="${dist}"></div>
        <div class="field"><input type="number" class="dope-adj" placeholder="e.g. 2.9" step="0.01" value="${adj}"></div>
        <button class="btn-remove-dope btn-danger btn-sm">✕</button>
    `;
    return div;
}

function getDopeEntries() {
    const rangeTemp = parseFloat($('range-temp-f').value);
    const rangeAlt  = parseFloat($('range-altitude-ft').value);
    const entries = [];
    document.querySelectorAll('.dope-row').forEach(row => {
        const dist = parseFloat(row.querySelector('.dope-dist').value);
        const adj  = parseFloat(row.querySelector('.dope-adj').value);
        if (!isNaN(dist) && !isNaN(adj)) {
            const e = { distance: toYards(dist), adjustment: toMils(adj) };
            if (!isNaN(rangeTemp)) e.temp_f = rangeTemp;
            if (!isNaN(rangeAlt))  e.altitude_ft = rangeAlt;
            entries.push(e);
        }
    });
    return entries;
}

// ── Output distances ──────────────────────────────────────────────────────────
function renderDistances() {
    const grid = $('output-distances');
    grid.innerHTML = '';
    const dl = distLabel();
    state.outputDistances.forEach(d => {
        const chip = document.createElement('div');
        chip.className = 'dist-chip';
        chip.innerHTML = `<span class="dist-blue" data-raw-dist="${d}">${d} ${dl}</span><span class="remove-dist" data-dist="${d}">✕</span>`;
        grid.appendChild(chip);
    });
}

$('output-distances').addEventListener('click', e => {
    if (e.target.classList.contains('remove-dist')) {
        const d = parseFloat(e.target.dataset.dist);
        state.outputDistances = state.outputDistances.filter(x => x !== d);
        renderDistances();
    }
});

$('btn-add-distance').addEventListener('click', addDistance);
$('new-distance').addEventListener('keydown', e => { if (e.key === 'Enter') addDistance(); });

function addDistance(val) {
    if (typeof val !== 'number') val = parseFloat($('new-distance').value);
    if (isNaN(val) || val < 1) { toast('Enter a valid distance', 'error'); return; }
    if (state.outputDistances.length >= 10) { toast('Maximum 10 distances', 'error'); return; }
    if (!state.outputDistances.includes(val)) {
        state.outputDistances.push(val);
        state.outputDistances.sort((a, b) => a - b);
        renderDistances();
    }
    $('new-distance').value = '';
}

document.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => addDistance(parseFloat(btn.dataset.dist)));
});

// ── Wind compass ──────────────────────────────────────────────────────────────
function windDesc(deg) {
    deg = ((deg % 360) + 360) % 360;
    if (deg < 22.5 || deg >= 337.5) return 'Headwind';
    if (deg < 67.5)  return 'Headwind/R→L';
    if (deg < 112.5) return 'R→L';
    if (deg < 157.5) return 'R→L/Tailwind';
    if (deg < 202.5) return 'Tailwind';
    if (deg < 247.5) return 'Tailwind/L→R';
    if (deg < 292.5) return 'L→R';
    return 'L→R/Headwind';
}

function setCompassAngle(deg) {
    deg = Math.round(((deg % 360) + 360) % 360);
    $('wind-angle').value = deg;
    $('compass-arrow').setAttribute('transform', `rotate(${deg})`);
    $('compass-angle-text').textContent = `${deg}°`;
    $('compass-desc-text').textContent  = windDesc(deg);
}

$('wind-compass').addEventListener('click', function (e) {
    const rect  = this.getBoundingClientRect();
    const svgX  = (e.clientX - rect.left) * (160 / rect.width);
    const svgY  = (e.clientY - rect.top)  * (200 / rect.height);
    const dx = svgX - 80;
    const dy = svgY - 90;
    setCompassAngle(Math.atan2(dx, -dy) * 180 / Math.PI);
    lsSave();
});

$('wind-angle').addEventListener('input', function () {
    setCompassAngle(parseFloat(this.value) || 0);
    lsSave();
});

// ── Wind condition batch ──────────────────────────────────────────────────────
function windCondLabel(cond) {
    return `${cond.speed} ${cond.unit} · ${cond.angle}°`;
}

function renderWindConditions() {
    const list = $('wind-condition-list');
    list.innerHTML = '';
    state.windConditions.forEach((cond, i) => {
        const chip = document.createElement('div');
        chip.className = 'dist-chip wind-cond-chip';
        chip.innerHTML = `<span>${windCondLabel(cond)}</span><span class="remove-dist" data-idx="${i}">✕</span>`;
        list.appendChild(chip);
    });
    $('btn-generate-batch-pdf').classList.toggle('hidden', state.windConditions.length === 0);
}

$('btn-add-wind-condition').addEventListener('click', () => {
    if (state.windConditions.length >= 10) { toast('Maximum 10 wind conditions', 'error'); return; }
    const speed = parseFloat($('wind-speed').value);
    const unit  = $('wind-unit').value;
    const angle = parseInt($('wind-angle').value) || 0;
    if (isNaN(speed) || speed < 0) { toast('Enter valid wind speed', 'error'); return; }
    state.windConditions.push({ speed, unit, angle });
    renderWindConditions();
    toast(`Added: ${windCondLabel({ speed, unit, angle })}`, 'success');
});

$('wind-condition-list').addEventListener('click', e => {
    if (e.target.classList.contains('remove-dist')) {
        state.windConditions.splice(parseInt(e.target.dataset.idx), 1);
        renderWindConditions();
    }
});

// ── Calculate ─────────────────────────────────────────────────────────────────
$('btn-calculate').addEventListener('click', async () => {
    if (state.outputDistances.length === 0) {
        toast('Add at least one output distance', 'error');
        return;
    }
    if (getDopeEntries().length < 3) {
        toast('Enter at least 3 Range DOPE entries', 'error');
        return;
    }

    const distMap = {};
    const outputYards = state.outputDistances.map(d => {
        const yards = toYards(d);
        distMap[Math.round(yards)] = d;
        return yards;
    });

    const basePayload = {
        velocity_fps:     parseFloat($('velocity-fps').value),
        bc_g7:            parseFloat($('bc-g7').value),
        bc_g1:            parseFloat($('bc-g1').value),
        bc_model:         $('bc-model').value,
        zero_yards:       toYards(parseFloat($('zero-yards').value)),
        sight_height_in:  parseFloat($('sight-height-in').value),
        altitude_ft:      parseFloat($('altitude-ft').value),
        temp_f:           parseFloat($('temp-f').value),
        dope_entries:     getDopeEntries(),
        output_distances: outputYards,
    };
    state.lastCalcPayload = basePayload;

    const payload = { ...basePayload };
    if ($('wind-details').open) {
        payload.wind_speed     = parseFloat($('wind-speed').value) || 0;
        payload.wind_unit      = $('wind-unit').value;
        payload.wind_angle_deg = parseFloat($('wind-angle').value) || 0;
    }

    const res = await fetch('/api/calculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok) { toast(data.error || 'Calculation failed', 'error'); return; }

    state.calculatedResults = {};
    Object.entries(data.results).forEach(([yardsKey, val]) => {
        const displayDist = distMap[parseInt(yardsKey)] ?? parseFloat(yardsKey);
        state.calculatedResults[String(displayDist)] = {
            elevation: fromMils(val.elevation),
            windage:   fromMils(val.windage),
        };
    });

    renderResultsTable();
    $('results-table').classList.remove('hidden');
    updateStickerPreview();
    $('pdf-section').scrollIntoView({ behavior: 'smooth' });
});

function renderResultsTable() {
    const tbody = document.querySelector('#results tbody');
    tbody.innerHTML = '';
    const cv = clickValue();

    const hasWind = Object.values(state.calculatedResults).some(v => Math.abs(v.windage) >= 0.05);
    $('results-windage-header').classList.toggle('hidden', !hasWind);

    Object.entries(state.calculatedResults)
        .sort(([a], [b]) => Number(a) - Number(b))
        .forEach(([dist, result]) => {
            const elev = result.elevation;
            const wind = result.windage;
            const clicks = Math.round(roundToClick(elev) / cv);
            let windCell = '';
            if (hasWind) {
                const arrow  = wind > 0.05 ? '→' : wind < -0.05 ? '←' : '–';
                const wClass = Math.abs(wind) >= 0.05 ? 'adj-amber' : 'adj-zero';
                windCell = `<td class="${wClass}">${arrow} ${fmtAdj(wind)}</td>`;
            }
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td class="dist-blue">${dist}</td>
                <td class="${adjClass(elev)}">${fmtAdj(elev)}</td>
                <td class="${adjClass(elev)}">${clicks > 0 ? '+' : ''}${clicks}</td>
                ${windCell}
                <td><input type="checkbox" class="sticker-check"
                    data-dist="${dist}" data-adj="${elev}" data-wind="${wind}" checked></td>
            `;
            tbody.appendChild(tr);
        });

    document.querySelectorAll('.sticker-check').forEach(cb => {
        cb.addEventListener('change', updateStickerPreview);
    });
}

// ── Sticker preview ───────────────────────────────────────────────────────────
function updateStickerPreview() {
    const checked = [...document.querySelectorAll('.sticker-check:checked')];
    const preview = $('sticker-preview');

    if (checked.length === 0) {
        preview.innerHTML = '<span class="preview-placeholder">No distances selected</span>';
        return;
    }

    const entries = checked
        .map(cb => ({
            distance: Number(cb.dataset.dist),
            adj:      Number(cb.dataset.adj),
            wind:     Number(cb.dataset.wind || 0),
        }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, 10);

    const hasWind = entries.some(e => Math.abs(e.wind) >= 0.05);

    const pairs = [];
    for (let i = 0; i < entries.length; i += 2)
        pairs.push([entries[i], entries[i + 1] || null]);

    const hvCls = hasWind ? ' preview-has-wind' : '';
    let rows = '';
    pairs.forEach(([left, right]) => {
        const lc = left.adj > 0 ? 'p-green' : left.adj < 0 ? 'p-red' : 'p-gray';
        const rc = right ? (right.adj > 0 ? 'p-green' : right.adj < 0 ? 'p-red' : 'p-gray') : '';
        const lwStr = hasWind && Math.abs(left.wind) >= 0.05
            ? (left.wind > 0 ? `>${Math.abs(left.wind).toFixed(1)}` : `<${Math.abs(left.wind).toFixed(1)}`)
            : '';
        const rwStr = right && hasWind && Math.abs(right.wind) >= 0.05
            ? (right.wind > 0 ? `>${Math.abs(right.wind).toFixed(1)}` : `<${Math.abs(right.wind).toFixed(1)}`)
            : '';

        rows += `<div class="preview-row">
            <div class="preview-half preview-left${hvCls}">
                <div class="preview-main">
                    <span class="preview-adj ${lc}">${fmtAdj(left.adj)}</span>
                    <span class="preview-dist">${left.distance}</span>
                </div>
                ${hasWind ? `<span class="preview-sub p-amber">${lwStr}</span>` : ''}
            </div>
            <div class="preview-divider"></div>
            ${right
                ? `<div class="preview-half preview-right${hvCls}">
                       <div class="preview-main">
                           <span class="preview-dist">${right.distance}</span>
                           <span class="preview-adj ${rc}">${fmtAdj(right.adj)}</span>
                       </div>
                       ${hasWind ? `<span class="preview-sub p-amber">${rwStr}</span>` : ''}
                   </div>`
                : '<div class="preview-half preview-right"></div>'}
        </div>`;
    });

    preview.innerHTML = `<div class="preview-circle"><div class="preview-table">${rows}</div></div>`;
}

// ── Label grid ────────────────────────────────────────────────────────────────
let selectedRow = 1;
let selectedCol = 1;

function buildLabelGrid() {
    const grid = $('label-grid');
    for (let r = 1; r <= 5; r++) {
        for (let c = 1; c <= 4; c++) {
            const cell = document.createElement('div');
            cell.className = 'grid-cell';
            cell.dataset.row = r;
            cell.dataset.col = c;
            cell.textContent = `R${r}C${c}`;
            if (r === 1 && c === 1) cell.classList.add('selected');
            cell.addEventListener('click', () => {
                document.querySelectorAll('.grid-cell').forEach(el => el.classList.remove('selected'));
                cell.classList.add('selected');
                selectedRow = r;
                selectedCol = c;
                $('label-row').value = r;
                $('label-col').value = c;
            });
            grid.appendChild(cell);
        }
    }
}

$('label-row').addEventListener('change', function () { selectedRow = parseInt(this.value); syncGridSelection(); });
$('label-col').addEventListener('change', function () { selectedCol = parseInt(this.value); syncGridSelection(); });

function syncGridSelection() {
    document.querySelectorAll('.grid-cell').forEach(el => {
        el.classList.toggle('selected',
            parseInt(el.dataset.row) === selectedRow && parseInt(el.dataset.col) === selectedCol);
    });
}

buildLabelGrid();

// ── Generate single-sticker PDF ───────────────────────────────────────────────
$('btn-generate-pdf').addEventListener('click', async () => {
    const checked = [...document.querySelectorAll('.sticker-check:checked')];
    if (checked.length === 0) { toast('No distances selected for sticker', 'error'); return; }
    if (checked.length > 10)  { toast('Maximum 10 entries on sticker', 'error'); return; }

    const dopeData = checked
        .map(cb => ({
            distance:   Number(cb.dataset.dist),
            adjustment: Number(cb.dataset.adj),
            windage:    Number(cb.dataset.wind || 0),
        }))
        .sort((a, b) => a.distance - b.distance);

    const windIsOpen = $('wind-details').open;
    const windLabel  = windIsOpen
        ? `${$('wind-speed').value} ${$('wind-unit').value} · ${$('wind-angle').value}°`
        : '';

    const payload = {
        dope_data:    dopeData,
        wind_label:   windLabel,
        label_row:    selectedRow,
        label_col:    selectedCol,
        session_name: $('session-name').value.trim(),
        offset_x_in:  parseFloat($('offset-x').value) || 0,
        offset_y_in:  parseFloat($('offset-y').value) || 0,
        fill_sheet:   $('fill-sheet').checked,
    };

    const res = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const data = await res.json();
        toast(data.error || 'PDF generation failed', 'error');
        return;
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    const sessionName = $('session-name').value.trim();
    a.download = sessionName ? sessionName.replace(/ /g, '_') + '.pdf' : 'dope-sticker.pdf';
    a.click();
    URL.revokeObjectURL(url);
    toast('PDF downloaded', 'success');
});

// ── Generate batch PDF ────────────────────────────────────────────────────────
$('btn-generate-batch-pdf').addEventListener('click', async () => {
    if (!state.lastCalcPayload) { toast('Calculate DOPE first', 'error'); return; }
    if (state.windConditions.length === 0) { toast('Add wind conditions to batch first', 'error'); return; }

    const checked = [...document.querySelectorAll('.sticker-check:checked')];
    if (checked.length === 0) { toast('No distances selected for sticker', 'error'); return; }

    const checkedDists = checked
        .map(cb => Number(cb.dataset.dist))
        .sort((a, b) => a - b);

    const stickers = [];
    for (const cond of state.windConditions) {
        const calcPayload = {
            ...state.lastCalcPayload,
            wind_speed:     cond.speed,
            wind_unit:      cond.unit,
            wind_angle_deg: cond.angle,
        };
        const res = await fetch('/api/calculate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(calcPayload),
        });
        if (!res.ok) { toast(`Calculation error for ${windCondLabel(cond)}`, 'error'); return; }
        const data = await res.json();

        const dopeData = checkedDists.map(d => {
            const yardsKey = String(Math.round(toYards(d)));
            const val = data.results[yardsKey];
            if (!val) return null;
            return {
                distance:   d,
                adjustment: roundToClick(fromMils(val.elevation)),
                windage:    roundToClick(fromMils(val.windage)),
            };
        }).filter(Boolean);

        stickers.push({ dope_data: dopeData, wind_label: windCondLabel(cond) });
    }

    const sessionName = $('session-name').value.trim();
    const payload = {
        stickers,
        label_row:    selectedRow,
        label_col:    selectedCol,
        session_name: sessionName,
        offset_x_in:  parseFloat($('offset-x').value) || 0,
        offset_y_in:  parseFloat($('offset-y').value) || 0,
    };

    const res = await fetch('/api/generate-pdf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });

    if (!res.ok) {
        const data = await res.json();
        toast(data.error || 'PDF generation failed', 'error');
        return;
    }

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = sessionName ? `${sessionName.replace(/ /g, '_')}_batch.pdf` : 'dope-batch.pdf';
    a.click();
    URL.revokeObjectURL(url);
    toast('Batch PDF downloaded', 'success');
});

// ── Sessions ──────────────────────────────────────────────────────────────────
function _collectSessionData() {
    const rangeTemp = parseFloat($('range-temp-f').value);
    const rangeAlt  = parseFloat($('range-altitude-ft').value);
    return {
        session_name:      $('session-name').value.trim(),
        dist_unit:         state.distUnit,
        adj_unit:          state.adjUnit,
        ammo_name:         $('ammo-select').value,
        velocity_fps:      parseFloat($('velocity-fps').value),
        bc_g7:             parseFloat($('bc-g7').value),
        bc_g1:             parseFloat($('bc-g1').value),
        bc_model:          $('bc-model').value,
        zero_yards:        parseFloat($('zero-yards').value),
        sight_height_in:   parseFloat($('sight-height-in').value),
        temp_f:            parseFloat($('temp-f').value),
        altitude_ft:       parseFloat($('altitude-ft').value),
        range_temp_f:      isNaN(rangeTemp) ? null : rangeTemp,
        range_altitude_ft: isNaN(rangeAlt)  ? null : rangeAlt,
        dope_entries_raw:  _rawDopeEntries(),
        output_distances:  state.outputDistances,
        wind_speed:        parseFloat($('wind-speed').value) || 0,
        wind_unit:         $('wind-unit').value,
        wind_angle:        parseInt($('wind-angle').value) || 0,
        wind_open:         $('wind-details').open,
        wind_conditions:   state.windConditions,
    };
}

function _rawDopeEntries() {
    const entries = [];
    document.querySelectorAll('.dope-row').forEach(row => {
        const dist = parseFloat(row.querySelector('.dope-dist').value);
        const adj  = parseFloat(row.querySelector('.dope-adj').value);
        if (!isNaN(dist) && !isNaN(adj)) entries.push({ distance: dist, adjustment: adj });
    });
    return entries;
}

function _applySessionData(data) {
    if (data.dist_unit) { $('dist-unit').value = data.dist_unit; state.distUnit = data.dist_unit; }
    if (data.adj_unit)  { $('adj-unit').value  = data.adj_unit;  state.adjUnit  = data.adj_unit; }
    applyUnits();

    $('session-name').value = data.session_name || '';
    if (data.ammo_name) {
        const opt = [...$('ammo-select').options].find(o => o.value === data.ammo_name);
        if (opt) $('ammo-select').value = data.ammo_name;
        $('ammo-select').dispatchEvent(new Event('change'));
    }
    if (data.velocity_fps)    $('velocity-fps').value    = data.velocity_fps;
    if (data.bc_g7)           $('bc-g7').value           = data.bc_g7;
    if (data.bc_g1)           $('bc-g1').value           = data.bc_g1;
    if (data.bc_model)        { $('bc-model').value = data.bc_model; _applyBcModel(data.bc_model); }
    if (data.zero_yards)      $('zero-yards').value      = data.zero_yards;
    if (data.sight_height_in) $('sight-height-in').value = data.sight_height_in;
    if (data.temp_f)          $('temp-f').value          = data.temp_f;
    if (data.altitude_ft !== undefined) $('altitude-ft').value = data.altitude_ft;

    $('range-temp-f').value      = data.range_temp_f      ?? '';
    $('range-altitude-ft').value = data.range_altitude_ft ?? '';

    if (data.wind_speed  !== undefined) $('wind-speed').value = data.wind_speed;
    if (data.wind_unit)                 $('wind-unit').value  = data.wind_unit;
    if (data.wind_angle  !== undefined) setCompassAngle(data.wind_angle);
    if (data.wind_open)                 $('wind-details').open = true;

    state.windConditions = data.wind_conditions || [];
    renderWindConditions();

    const container = $('dope-entries');
    container.innerHTML = '';
    const entries = data.dope_entries_raw || data.dope_entries || [];
    entries.forEach(e => container.appendChild(buildDopeRow(e.distance, e.adjustment)));
    if (!container.querySelector('.dope-row')) container.appendChild(buildDopeRow());

    state.outputDistances = data.output_distances || [];
    renderDistances();
    lsSave();
}

$('btn-save-session').addEventListener('click', () => {
    const data = _collectSessionData();
    const name = data.session_name || 'dope-session';
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = name.replace(/ /g, '_') + '.dope';
    a.click();
    URL.revokeObjectURL(url);
    toast('Saved ' + a.download, 'success');
});

$('btn-load-session').addEventListener('click', () => $('file-load-input').click());

$('file-load-input').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
        try {
            _applySessionData(JSON.parse(e.target.result));
            toast('Loaded ' + file.name, 'success');
        } catch {
            toast('Invalid .dope file', 'error');
        }
    };
    reader.readAsText(file);
    this.value = '';
});

// ── Init ──────────────────────────────────────────────────────────────────────
lsRestore();
