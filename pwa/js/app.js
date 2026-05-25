/**
 * DOPE Calculator PWA — offline-capable client-side app.
 * All ballistics calculations run locally; ammo synced from server when online.
 */

import { interpolateDope, WIND_TO_FPS } from './ballistics.js';
import { initDB, getAmmo, syncAmmoFromServer, addAmmoLocal } from './db.js';
import { drawSticker, loadFonts } from './canvas-sticker.js';
import { isBluetoothAvailable, connectNiimbot, isConnected, printSticker } from './niimbot.js';

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
    outputDistances:   [],
    calculatedResults: {},
    distUnit:          'yd',
    adjUnit:           'mrad',
    windConditions:    [],
    lastCalcParams:    null,
    ammoList:          [],
};

// ── Conversions ────────────────────────────────────────────────────────────────
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

function fmtWindStr(v) {
    const rv = roundToClick(v);
    if (Math.abs(rv) < 0.05) return '';
    return (rv > 0 ? '>' : '<') + Math.abs(rv).toFixed(adjDecimals());
}

// ── DOM helpers ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function toast(msg, type = '') {
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast${type ? ' ' + type : ''}`;
    el.classList.remove('hidden');
    clearTimeout(el._t);
    el._t = setTimeout(() => el.classList.add('hidden'), 3000);
}

// ── Units ──────────────────────────────────────────────────────────────────────
function applyUnits() {
    const dl = distLabel();
    const al = adjLabel();
    const cv = clickValue();

    $('dope-dist-header').textContent       = `Distance (${dl})`;
    $('dope-adj-header').textContent        = `Adjustment (${al})`;
    $('zero-yards-label').textContent       = `Zero Distance (${dl})`;
    $('results-dist-header').textContent    = `Distance (${dl})`;
    $('results-adj-header').textContent     = `Adjustment (${al})`;
    $('results-clicks-header').textContent  = `Clicks (${cv} ${al})`;
    $('results-windage-header').textContent = `Windage (${al})`;
    $('new-distance').placeholder           = `Custom distance (${dl})`;

    document.querySelectorAll('.dist-chip span.dist-blue').forEach(el => {
        const d = el.dataset.rawDist;
        if (d !== undefined) el.textContent = `${d} ${dl}`;
    });

    const adjExample = state.adjUnit === 'moa' ? '8.75' : '2.9';
    const adjStep    = state.adjUnit === 'moa' ? '0.25' : '0.01';
    document.querySelectorAll('.dope-adj').forEach(el => {
        el.placeholder = `e.g. ${adjExample}`;
        el.step        = adjStep;
    });
}

$('dist-unit').addEventListener('change', function () {
    state.distUnit = this.value;
    state.outputDistances   = [];
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

// ── localStorage ───────────────────────────────────────────────────────────────
const LS_PREFIX = 'dope_pwa_';
const LS_FIELDS = ['velocity-fps', 'bc-g7', 'bc-g1', 'bc-model',
                   'zero-yards', 'sight-height-in', 'temp-f', 'altitude-ft',
                   'dist-unit', 'adj-unit', 'wind-speed', 'wind-angle', 'wind-unit'];

function lsSave() {
    LS_FIELDS.forEach(id => {
        const el = $(id);
        if (el) localStorage.setItem(LS_PREFIX + id, el.value);
    });
}

function lsRestore() {
    LS_FIELDS.forEach(id => {
        const saved = localStorage.getItem(LS_PREFIX + id);
        const el    = $(id);
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

// ── BC model ───────────────────────────────────────────────────────────────────
function _applyBcModel(model) {
    $('field-bc-g7').classList.toggle('hidden', model !== 'g7');
    $('field-bc-g1').classList.toggle('hidden', model !== 'g1');
}

$('bc-model').addEventListener('change', function () {
    _applyBcModel(this.value);
    lsSave();
});

// ── Ammo (from IndexedDB) ──────────────────────────────────────────────────────
function _buildAmmoOptions() {
    const calSel  = $('caliber-select');
    const ammoSel = $('ammo-select');
    const currentCal  = calSel.value;
    const currentAmmo = ammoSel.value;

    calSel.innerHTML  = '';
    ammoSel.innerHTML = '';

    const calibers = [...new Set(state.ammoList.map(a => a.caliber))].sort();
    calibers.forEach(cal => {
        const opt = document.createElement('option');
        opt.value       = cal;
        opt.textContent = cal;
        calSel.appendChild(opt);
    });

    state.ammoList.forEach(a => {
        const opt = document.createElement('option');
        opt.value            = a.name;
        opt.textContent      = a.name;
        opt.dataset.caliber  = a.caliber;
        opt.dataset.velocity = a.velocity_fps;
        opt.dataset.bcg7     = a.bc_g7;
        opt.dataset.bcg1     = a.bc_g1;
        ammoSel.appendChild(opt);
    });

    if (currentCal  && calibers.includes(currentCal))  calSel.value  = currentCal;
    if (currentAmmo && state.ammoList.find(a => a.name === currentAmmo)) ammoSel.value = currentAmmo;

    filterAmmoByCaliber(calSel.value);
}

function filterAmmoByCaliber(caliber) {
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
    filterAmmoByCaliber(this.value);
});

$('ammo-select').addEventListener('change', function () {
    const opt = this.selectedOptions[0];
    if (opt) {
        $('velocity-fps').value = opt.dataset.velocity;
        $('bc-g7').value        = opt.dataset.bcg7;
        $('bc-g1').value        = opt.dataset.bcg1;
        lsSave();
    }
});

// ── Add local ammo ─────────────────────────────────────────────────────────────
$('btn-show-add-ammo').addEventListener('click', () => {
    $('add-ammo-form').classList.toggle('hidden');
});

$('btn-add-ammo').addEventListener('click', async () => {
    const entry = {
        caliber:      $('new-ammo-caliber').value.trim(),
        name:         $('new-ammo-name').value.trim(),
        velocity_fps: parseFloat($('new-ammo-vel').value),
        bc_g1:        parseFloat($('new-ammo-bcg1').value),
        bc_g7:        parseFloat($('new-ammo-bcg7').value),
    };
    if (!entry.caliber) { toast('Enter caliber', 'error'); return; }
    if (!entry.name)    { toast('Enter ammo name', 'error'); return; }
    try {
        await addAmmoLocal(entry);
        state.ammoList = await getAmmo();
        _buildAmmoOptions();
        $('add-ammo-form').classList.add('hidden');
        toast(`Added locally: ${entry.name}`, 'success');
    } catch (err) {
        toast('Error saving ammo', 'error');
    }
});

// ── Sync button ────────────────────────────────────────────────────────────────
$('btn-sync-ammo').addEventListener('click', async () => {
    toast('Syncing ammo...', '');
    const ok = await syncAmmoFromServer();
    if (ok) {
        state.ammoList = await getAmmo();
        _buildAmmoOptions();
        toast('Ammo synced', 'success');
    } else {
        toast('Sync failed — offline?', 'error');
    }
});

// ── DOPE entries ───────────────────────────────────────────────────────────────
['', '', ''].forEach(() => $('dope-entries').appendChild(buildDopeRow()));

$('btn-add-dope').addEventListener('click', () => {
    $('dope-entries').appendChild(buildDopeRow());
});

$('dope-entries').addEventListener('click', e => {
    if (e.target.classList.contains('btn-remove-dope'))
        e.target.closest('.dope-row').remove();
});

function buildDopeRow(dist = '', adj = '') {
    const adjExample = state.adjUnit === 'moa' ? '8.75' : '2.9';
    const adjStep    = state.adjUnit === 'moa' ? '0.25' : '0.01';
    const div = document.createElement('div');
    div.className = 'dope-row';
    div.innerHTML = `
        <div class="field"><input type="number" class="dope-dist" placeholder="e.g. 100" min="1" step="1" value="${dist}"></div>
        <div class="field"><input type="number" class="dope-adj" placeholder="e.g. ${adjExample}" step="${adjStep}" value="${adj}"></div>
        <button class="btn-remove-dope btn-danger btn-sm">✕</button>
    `;
    return div;
}

function getDopeEntries() {
    const rangeTemp = parseFloat($('range-temp-f').value);
    const rangeAlt  = parseFloat($('range-altitude-ft').value);
    const entries   = [];
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

// ── Output distances ───────────────────────────────────────────────────────────
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

// ── Wind compass ───────────────────────────────────────────────────────────────
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
    const rect = this.getBoundingClientRect();
    const svgX = (e.clientX - rect.left) * (160 / rect.width);
    const svgY = (e.clientY - rect.top)  * (200 / rect.height);
    setCompassAngle(Math.atan2(svgX - 80, -(svgY - 90)) * 180 / Math.PI);
    lsSave();
});

$('wind-angle').addEventListener('input', function () {
    setCompassAngle(parseFloat(this.value) || 0);
    lsSave();
});

// ── Wind batch ─────────────────────────────────────────────────────────────────
function windCondLabel(cond) { return `${cond.speed} ${cond.unit} · ${cond.angle}°`; }

function renderWindConditions() {
    const list = $('wind-condition-list');
    list.innerHTML = '';
    state.windConditions.forEach((cond, i) => {
        const chip = document.createElement('div');
        chip.className = 'dist-chip wind-cond-chip';
        chip.innerHTML = `<span>${windCondLabel(cond)}</span><span class="remove-dist" data-idx="${i}">✕</span>`;
        list.appendChild(chip);
    });
    const hasBatch = state.windConditions.length > 0;
    $('btn-print-batch').classList.toggle('hidden', !hasBatch || !isConnected());
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

// ── Calculate (client-side) ────────────────────────────────────────────────────
function _buildCalcParams(windSpeedFps, windAngleDeg) {
    const bcModel = $('bc-model').value;
    const bc      = parseFloat(bcModel === 'g7' ? $('bc-g7').value : $('bc-g1').value);
    return {
        muzzle_velocity_fps: parseFloat($('velocity-fps').value),
        bc,
        bc_model:        bcModel,
        zero_distance_yards: toYards(parseFloat($('zero-yards').value)),
        altitude_ft:     parseFloat($('altitude-ft').value),
        temp_f:          parseFloat($('temp-f').value),
        sight_height_in: parseFloat($('sight-height-in').value),
        wind_speed_fps:  windSpeedFps,
        wind_angle_deg:  windAngleDeg,
        dope_entries:    getDopeEntries(),
    };
}

function _calcForDist(params, displayDist) {
    const yards = toYards(displayDist);
    const res   = interpolateDope({ ...params, target_distance: yards });
    return { elevation: fromMils(res.elevation), windage: fromMils(res.windage) };
}

$('btn-calculate').addEventListener('click', () => {
    if (state.outputDistances.length === 0) { toast('Add at least one output distance', 'error'); return; }
    if (getDopeEntries().length < 3) { toast('Enter at least 3 Range DOPE entries', 'error'); return; }

    let windFps = 0, windAngle = 0;
    if ($('wind-details').open) {
        const speed = parseFloat($('wind-speed').value) || 0;
        const unit  = $('wind-unit').value;
        windFps   = speed * (WIND_TO_FPS[unit] || 1.46667);
        windAngle = parseFloat($('wind-angle').value) || 0;
    }

    const params = _buildCalcParams(windFps, windAngle);
    state.lastCalcParams = params;

    state.calculatedResults = {};
    try {
        for (const d of state.outputDistances) {
            state.calculatedResults[String(d)] = _calcForDist(params, d);
        }
    } catch (err) {
        toast('Calculation error: ' + err.message, 'error');
        return;
    }

    renderResultsTable();
    $('results-table').classList.remove('hidden');
    updateStickerPreview();
    $('print-section').scrollIntoView({ behavior: 'smooth' });
});

function renderResultsTable() {
    const tbody = document.querySelector('#results tbody');
    tbody.innerHTML = '';
    const cv      = clickValue();
    const hasWind = Object.values(state.calculatedResults).some(v => Math.abs(v.windage) >= 0.05);
    $('results-windage-header').classList.toggle('hidden', !hasWind);

    Object.entries(state.calculatedResults)
        .sort(([a], [b]) => Number(a) - Number(b))
        .forEach(([dist, result]) => {
            const elev   = result.elevation;
            const wind   = result.windage;
            const clicks = Math.round(roundToClick(elev) / cv);
            let windCell = '';
            if (hasWind) {
                const arrow  = wind > 0.05 ? '→' : wind < -0.05 ? '←' : '–';
                const wClass = Math.abs(wind) >= 0.05 ? 'adj-amber' : 'adj-zero';
                windCell = `<td class="${wClass}">${arrow} ${fmtAdj(wind)}</td>`;
            }
            const elevR = roundToClick(elev);
            const windR = roundToClick(wind);
            const tr    = document.createElement('tr');
            tr.innerHTML = `
                <td class="dist-blue">${dist}</td>
                <td class="${adjClass(elev)}">${fmtAdj(elev)}</td>
                <td class="${adjClass(elev)}">${clicks > 0 ? '+' : ''}${clicks}</td>
                ${windCell}
                <td><input type="checkbox" class="sticker-check"
                    data-dist="${dist}" data-adj="${elevR}" data-wind="${windR}" checked></td>
            `;
            tbody.appendChild(tr);
        });

    document.querySelectorAll('.sticker-check').forEach(cb => {
        cb.addEventListener('change', function () {
            if (this.checked && document.querySelectorAll('.sticker-check:checked').length > 8) {
                this.checked = false;
                toast('Maximum 8 entries on sticker', 'error');
                return;
            }
            updateStickerPreview();
        });
    });
}

// ── Sticker preview (canvas) ───────────────────────────────────────────────────
let _fontsLoaded = false;

async function _ensureFonts() {
    if (!_fontsLoaded) { await loadFonts(); _fontsLoaded = true; }
}

function _getCheckedDopeData() {
    return [...document.querySelectorAll('.sticker-check:checked')]
        .map(cb => ({ dist: Number(cb.dataset.dist), adj: Number(cb.dataset.adj), wind: Number(cb.dataset.wind || 0) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, 8);
}

function _windLabel() {
    if (!$('wind-details').open) return '';
    return `${$('wind-speed').value} ${$('wind-unit').value} · ${$('wind-angle').value}°`;
}

async function updateStickerPreview() {
    const canvas = $('sticker-canvas');
    const ph     = $('preview-placeholder');
    const entries = _getCheckedDopeData();

    if (entries.length === 0) {
        canvas.classList.add('hidden');
        ph.classList.remove('hidden');
        $('btn-save-png').classList.add('hidden');
        return;
    }

    await _ensureFonts();
    // Redraw canvas to match current display size
    const size = canvas.offsetWidth || 144;
    canvas.width  = size;
    canvas.height = size;

    drawSticker(
        canvas,
        entries.map(e => [e.dist, e.adj, e.wind]),
        _windLabel(),
        adjDecimals(),
    );

    canvas.classList.remove('hidden');
    ph.classList.add('hidden');
    $('btn-save-png').classList.remove('hidden');
}

// ── Niimbot ────────────────────────────────────────────────────────────────────
let _niimbotName = null;

if (!isBluetoothAvailable()) {
    $('niimbot-unavailable').classList.remove('hidden');
    $('btn-connect-niimbot').classList.add('hidden');
}

$('btn-connect-niimbot').addEventListener('click', async () => {
    try {
        toast('Searching for printer...', '');
        _niimbotName = await connectNiimbot();
        $('niimbot-status').textContent = `Connected: ${_niimbotName}`;
        $('niimbot-status').className   = 'niimbot-status connected';
        $('btn-print-sticker').classList.remove('hidden');
        renderWindConditions();  // shows batch button if conditions exist
        toast(`Connected to ${_niimbotName}`, 'success');
    } catch (err) {
        toast(err.message, 'error');
    }
});

$('btn-print-sticker').addEventListener('click', async () => {
    await _printSingle(_windLabel());
});

$('btn-print-batch').addEventListener('click', async () => {
    if (!state.lastCalcParams) { toast('Calculate DOPE first', 'error'); return; }
    if (state.windConditions.length === 0) { toast('No wind conditions in batch', 'error'); return; }

    const checkedDists = [...document.querySelectorAll('.sticker-check:checked')]
        .map(cb => Number(cb.dataset.dist))
        .sort((a, b) => a - b);

    for (let i = 0; i < state.windConditions.length; i++) {
        const cond    = state.windConditions[i];
        const windFps = cond.speed * (WIND_TO_FPS[cond.unit] || 1.46667);
        const params  = { ...state.lastCalcParams, wind_speed_fps: windFps, wind_angle_deg: cond.angle };
        const dopeData = checkedDists.map(d => {
            const res = interpolateDope({ ...params, target_distance: toYards(d) });
            return [d, roundToClick(fromMils(res.elevation)), roundToClick(fromMils(res.windage))];
        });
        await _printCanvasData(dopeData, windCondLabel(cond), `${i + 1}/${state.windConditions.length}`);
    }
    toast('Batch print complete', 'success');
});

async function _printSingle(label) {
    const entries = _getCheckedDopeData();
    if (entries.length === 0) { toast('No distances selected', 'error'); return; }
    const dopeData = entries.map(e => [e.dist, e.adj, e.wind]);
    await _printCanvasData(dopeData, label, '');
}

async function _printCanvasData(dopeData, label, progressPrefix) {
    await _ensureFonts();
    const printCanvas = document.createElement('canvas');
    printCanvas.width  = 400;
    printCanvas.height = 400;
    drawSticker(printCanvas, dopeData, label, adjDecimals());

    $('print-progress').classList.remove('hidden');
    $('btn-print-sticker').disabled = true;
    $('btn-print-batch').disabled   = true;

    try {
        await printSticker(printCanvas, (line, total) => {
            $('print-progress-bar').value = line;
            $('print-progress-bar').max   = total;
            $('print-progress-text').textContent = `${progressPrefix ? progressPrefix + ' ' : ''}${Math.round(line / total * 100)}%`;
        });
        toast('Printed!', 'success');
    } catch (err) {
        toast('Print error: ' + err.message, 'error');
    } finally {
        $('print-progress').classList.add('hidden');
        $('btn-print-sticker').disabled = false;
        $('btn-print-batch').disabled   = false;
    }
}

$('btn-save-png').addEventListener('click', () => {
    const canvas = $('sticker-canvas');
    if (!canvas) return;
    canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href     = url;
        a.download = ($('session-name').value.trim().replace(/ /g, '_') || 'dope-sticker') + '.png';
        a.click();
        URL.revokeObjectURL(url);
    });
});

// ── Sessions ───────────────────────────────────────────────────────────────────
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
        if (opt) { $('ammo-select').value = data.ammo_name; $('ammo-select').dispatchEvent(new Event('change')); }
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

    if (data.wind_speed !== undefined)  $('wind-speed').value = data.wind_speed;
    if (data.wind_unit)                 $('wind-unit').value  = data.wind_unit;
    if (data.wind_angle !== undefined)  setCompassAngle(data.wind_angle);
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
        try { _applySessionData(JSON.parse(e.target.result)); toast('Loaded ' + file.name, 'success'); }
        catch { toast('Invalid .dope file', 'error'); }
    };
    reader.readAsText(file);
    this.value = '';
});

// ── PWA install prompt ─────────────────────────────────────────────────────────
let _deferredInstall = null;

window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    _deferredInstall = e;
    $('install-banner').classList.remove('hidden');
});

$('btn-install').addEventListener('click', () => {
    if (_deferredInstall) { _deferredInstall.prompt(); _deferredInstall = null; }
    $('install-banner').classList.add('hidden');
});

$('btn-dismiss-install').addEventListener('click', () => {
    $('install-banner').classList.add('hidden');
});

// ── Online/offline indicator ───────────────────────────────────────────────────
function _updateOnlineStatus() {
    const online = navigator.onLine;
    $('online-dot').className  = 'online-dot ' + (online ? 'dot-online' : 'dot-offline');
    $('online-text').textContent = online ? 'Online' : 'Offline';
}

window.addEventListener('online',  _updateOnlineStatus);
window.addEventListener('offline', _updateOnlineStatus);
_updateOnlineStatus();

// ── Init ───────────────────────────────────────────────────────────────────────
async function init() {
    await initDB();

    // Start server sync in background; immediately load from IndexedDB
    syncAmmoFromServer();  // non-blocking
    state.ammoList = await getAmmo();

    if (state.ammoList.length === 0) {
        $('ammo-empty-notice').classList.remove('hidden');
    } else {
        _buildAmmoOptions();
    }

    lsRestore();

    // Register service worker
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/pwa/service-worker.js', { scope: '/pwa/' })
            .catch(err => console.warn('SW registration failed:', err));
    }
}

init();
