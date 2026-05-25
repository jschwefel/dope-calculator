/*
 * Copyright (C) 2026 Jason M. Schwefel
 *
 * This file is part of DOPE Sticker Calculator.
 *
 * DOPE Sticker Calculator is free software: you can redistribute it and/or
 * modify it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * DOPE Sticker Calculator is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with DOPE Sticker Calculator.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Niimbot B1 Web Bluetooth printing.
 *
 * Protocol reverse-engineered from the niimprint project.
 * BLE UUIDs are specific to Niimbot printers.
 *
 * NOTE: Web Bluetooth requires a secure context (HTTPS) and is supported on
 * Chrome/Edge on Android and desktop. Not supported on iOS Safari.
 *
 * Print label size: 50mm × 50mm at 203 DPI = 400 × 400 dots.
 */

const SERVICE_UUID  = '0000ae30-0000-1000-8000-00805f9b34fb';
const WRITE_UUID    = '0000ae01-0000-1000-8000-00805f9b34fb';
const NOTIFY_UUID   = '0000ae02-0000-1000-8000-00805f9b34fb';

const CMD = {
    SET_LABEL_TYPE:    0x23,
    SET_LABEL_DENSITY: 0x21,
    START_PRINT:       0x01,
    END_PRINT:         0xF3,
    START_PAGE_PRINT:  0x03,
    END_PAGE_PRINT:    0xE3,
    SET_DIMENSION:     0x13,
    DRAW_BITMAP:       0x85,
    GET_PRINT_STATUS:  0xA3,
};

// Label dimensions in dots at 203 DPI
const LABEL_DOTS = 400;

let _device       = null;
let _writeChar    = null;

function _buildPacket(command, data = []) {
    const pkt = [0x55, 0x55, command, data.length, ...data];
    let checksum = 0;
    for (let i = 2; i < pkt.length; i++) checksum ^= pkt[i];
    pkt.push(checksum, 0xAA, 0xAA);
    return new Uint8Array(pkt);
}

async function _send(command, data = []) {
    if (!_writeChar) throw new Error('Printer not connected');
    await _writeChar.writeValue(_buildPacket(command, data));
    // Small delay between packets to avoid buffer overflow
    await new Promise(r => setTimeout(r, 3));
}

export function isBluetoothAvailable() {
    return !!(navigator.bluetooth);
}

export async function connectNiimbot() {
    if (!navigator.bluetooth) {
        throw new Error('Web Bluetooth not supported. Use Chrome or Edge on Android or desktop.');
    }

    _device = await navigator.bluetooth.requestDevice({
        filters:          [{ services: [SERVICE_UUID] }],
        optionalServices: [SERVICE_UUID],
    });

    const server  = await _device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    _writeChar    = await service.getCharacteristic(WRITE_UUID);

    const notifyChar = await service.getCharacteristic(NOTIFY_UUID);
    await notifyChar.startNotifications();

    _device.addEventListener('gattserverdisconnected', () => {
        _device    = null;
        _writeChar = null;
    });

    return _device.name || 'Niimbot Printer';
}

export function isConnected() {
    return !!((_device && _device.gatt.connected));
}

export async function disconnectNiimbot() {
    if (_device && _device.gatt.connected) {
        _device.gatt.disconnect();
    }
}

/**
 * Print a sticker from a canvas element or offscreen canvas.
 * The canvas should be 400×400 pixels (50mm × 50mm at 203 DPI).
 * @param {HTMLCanvasElement} canvas
 * @param {function} [onProgress] - called with (line, total) as lines are sent
 */
export async function printSticker(canvas, onProgress) {
    if (!_writeChar) throw new Error('Printer not connected');

    const W = LABEL_DOTS;
    const H = LABEL_DOTS;

    // Render to print canvas (force 400×400 with white background)
    let printCanvas;
    if (canvas.width === W && canvas.height === H) {
        printCanvas = canvas;
    } else {
        printCanvas = document.createElement('canvas');
        printCanvas.width  = W;
        printCanvas.height = H;
        const pctx = printCanvas.getContext('2d');
        pctx.fillStyle = '#FFFFFF';
        pctx.fillRect(0, 0, W, H);
        pctx.drawImage(canvas, 0, 0, W, H);
    }

    const imageData = printCanvas.getContext('2d').getImageData(0, 0, W, H).data;

    // Initialize print job
    await _send(CMD.SET_LABEL_TYPE,    [0x01]);
    await _send(CMD.SET_LABEL_DENSITY, [0x03]);   // medium density
    await _send(CMD.START_PRINT,       [0x01]);
    await _send(CMD.START_PAGE_PRINT,  []);
    // SET_DIMENSION: [height_hi, height_lo, width_hi, width_lo]
    await _send(CMD.SET_DIMENSION, [H >> 8, H & 0xFF, W >> 8, W & 0xFF]);

    // Send bitmap line by line
    for (let y = 0; y < H; y++) {
        const lineData = [y >> 8, y & 0xFF];
        for (let x = 0; x < W; x += 8) {
            let byte = 0;
            for (let bit = 0; bit < 8; bit++) {
                const px = x + bit;
                if (px < W) {
                    const idx = (y * W + px) * 4;
                    // Threshold: luminance < 128 → black (print)
                    const lum = 0.299 * imageData[idx] + 0.587 * imageData[idx + 1] + 0.114 * imageData[idx + 2];
                    if (lum < 128) byte |= (0x80 >> bit);
                }
            }
            lineData.push(byte);
        }
        await _send(CMD.DRAW_BITMAP, lineData);
        if (onProgress) onProgress(y + 1, H);
    }

    await _send(CMD.END_PAGE_PRINT, []);
    await new Promise(r => setTimeout(r, 200));
    await _send(CMD.END_PRINT, []);
}
