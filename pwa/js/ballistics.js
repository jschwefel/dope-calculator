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
 * Ballistics calculations — ES6 module port of app/ballistics.py.
 * All functions are synchronous.
 */

const STANDARD_TEMP_F     = 59.0;
const GRAVITY_FPS2        = 32.174;
const SPEED_OF_SOUND_FPS  = 1116.45;

export const WIND_TO_FPS = {
    'mph':  1.46667,
    'fps':  1.0,
    'km/h': 0.91134,
    'm/s':  3.28084,
};

export function airDensityRatio(altitude_ft, temp_f) {
    const temp_r     = temp_f + 459.67;
    const std_temp_r = STANDARD_TEMP_F + 459.67;
    const pressure_ratio = Math.pow(1.0 - 6.87559e-6 * altitude_ft, 5.2561);
    return pressure_ratio * (std_temp_r / temp_r);
}

function _g7Cd(mach) {
    if (mach < 0.7) return 0.1198;
    if (mach < 0.9) return 0.1197;
    if (mach < 1.0) return 0.1200;
    return 0.1500;
}

function _g1Cd(mach) {
    if (mach < 0.6) return 0.2629;
    if (mach < 0.7) return 0.2782;
    if (mach < 0.8) return 0.3101;
    if (mach < 0.9) return 0.3702;
    if (mach < 1.0) return 0.4485;
    if (mach < 1.1) return 0.5150;
    if (mach < 1.2) return 0.5203;
    if (mach < 1.3) return 0.5078;
    if (mach < 1.5) return 0.4775;
    if (mach < 1.7) return 0.4483;
    return 0.4037;
}

export function windComponents(speed_fps, angle_deg) {
    const rad = angle_deg * Math.PI / 180;
    return [speed_fps * Math.cos(rad), speed_fps * Math.sin(rad)];
}

function _integrate(muzzle_velocity_fps, bc_eff, cdFn, distance_yards, headwind_fps = 0.0) {
    let v        = muzzle_velocity_fps;
    const step_yd = 0.5;
    const step_ft = step_yd * 3.0;
    let drop_ft   = 0.0;
    let drop_vel  = 0.0;
    let t_flight  = 0.0;
    let total_yd  = 0.0;

    while (total_yd < distance_yards) {
        const dt    = step_ft / Math.max(v, 1.0);
        const v_rel = Math.max(v + headwind_fps, 1.0);
        const mach  = v_rel / SPEED_OF_SOUND_FPS;
        const cd    = cdFn(mach);
        const decel = (0.5 * cd * v_rel * v_rel) / (bc_eff * SPEED_OF_SOUND_FPS * SPEED_OF_SOUND_FPS);
        v          = Math.max(v - decel * step_ft, 1.0);

        t_flight += dt;
        drop_vel += GRAVITY_FPS2 * dt;
        drop_ft  += drop_vel * dt + 0.5 * GRAVITY_FPS2 * dt * dt;
        total_yd += step_yd;
    }

    return [drop_ft, t_flight];
}

function _trajectoryMils(drop_d, drop_z, dist_yards, zero_yards, sight_height_in) {
    if (dist_yards <= 0) return 0.0;
    const h_ft      = sight_height_in / 12.0;
    const scale     = dist_yards / zero_yards;
    const needed_ft = drop_d + h_ft - scale * (drop_z + h_ft);
    return (needed_ft * 12.0) / (dist_yards * 36.0 / 1000.0);
}

function _windageMils(crosswind_fps, tof_s, distance_yards, muzzle_velocity_fps) {
    if (distance_yards <= 0 || crosswind_fps === 0.0) return 0.0;
    const t_vacuum = (distance_yards * 3.0) / Math.max(muzzle_velocity_fps, 1.0);
    const drift_in = crosswind_fps * (tof_s - t_vacuum) * 12.0;
    return drift_in / (distance_yards * 36.0 / 1000.0);
}

function calculateTrajectory({
    muzzle_velocity_fps,
    bc,
    zero_distance_yards,
    distances_yards,
    altitude_ft   = 0.0,
    temp_f        = 59.0,
    bc_model      = 'g7',
    sight_height_in = 1.5,
    wind_speed_fps  = 0.0,
    wind_angle_deg  = 0.0,
}) {
    const [hw, cw] = windComponents(wind_speed_fps, wind_angle_deg);
    const density_ratio = airDensityRatio(altitude_ft, temp_f);
    const bc_eff = bc / density_ratio;
    const cdFn   = bc_model === 'g7' ? _g7Cd : _g1Cd;

    const [drop_z] = _integrate(muzzle_velocity_fps, bc_eff, cdFn, zero_distance_yards, hw);

    const results = {};
    for (const dist of distances_yards) {
        if (dist === 0) { results[dist] = { elevation: 0.0, windage: 0.0 }; continue; }
        const [drop_d, tof] = _integrate(muzzle_velocity_fps, bc_eff, cdFn, dist, hw);
        const elev = _trajectoryMils(drop_d, drop_z, dist, zero_distance_yards, sight_height_in);
        const wind = _windageMils(cw, tof, dist, muzzle_velocity_fps);
        results[dist] = { elevation: elev, windage: wind };
    }
    return results;
}

function _entryBias(entry, muzzle_velocity_fps, bc, zero_distance_yards, match_altitude_ft, match_temp_f, bc_model, sight_height_in) {
    const range_temp = entry.temp_f      ?? match_temp_f;
    const range_alt  = entry.altitude_ft ?? match_altitude_ft;
    const model_elev = calculateTrajectory({
        muzzle_velocity_fps,
        bc,
        zero_distance_yards,
        distances_yards: [entry.distance],
        altitude_ft: range_alt,
        temp_f: range_temp,
        bc_model,
        sight_height_in,
    })[entry.distance].elevation;
    return entry.adjustment - model_elev;
}

export function interpolateDope({
    dope_entries,
    target_distance,
    muzzle_velocity_fps,
    bc,
    zero_distance_yards,
    altitude_ft     = 0.0,
    temp_f          = 59.0,
    bc_model        = 'g7',
    sight_height_in = 1.5,
    wind_speed_fps  = 0.0,
    wind_angle_deg  = 0.0,
}) {
    const match_day = calculateTrajectory({
        muzzle_velocity_fps,
        bc,
        zero_distance_yards,
        distances_yards: [target_distance],
        altitude_ft,
        temp_f,
        bc_model,
        sight_height_in,
        wind_speed_fps,
        wind_angle_deg,
    })[target_distance];

    if (!dope_entries || dope_entries.length === 0) return match_day;

    const biased = dope_entries
        .map(e => ({
            ...e,
            _bias: _entryBias(e, muzzle_velocity_fps, bc, zero_distance_yards, altitude_ft, temp_f, bc_model, sight_height_in),
        }))
        .sort((a, b) => a.distance - b.distance);

    for (const e of biased) {
        if (e.distance === target_distance) {
            return { elevation: Math.round((match_day.elevation + e._bias) * 10) / 10, windage: match_day.windage };
        }
    }

    let lower = null, upper = null;
    for (const e of biased) {
        if (e.distance < target_distance) lower = e;
        else if (e.distance > target_distance && upper === null) upper = e;
    }

    if (lower && upper) {
        const frac        = (target_distance - lower.distance) / (upper.distance - lower.distance);
        const interp_bias = lower._bias + frac * (upper._bias - lower._bias);
        return { elevation: Math.round((match_day.elevation + interp_bias) * 10) / 10, windage: match_day.windage };
    }

    const nearest = lower ?? upper;
    return { elevation: Math.round((match_day.elevation + nearest._bias) * 10) / 10, windage: match_day.windage };
}
