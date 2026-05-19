"""
Ballistic calculations for the DOPE calculator.

Supports G1 and G7 drag models with environmental corrections for
temperature and altitude. Sight height is accounted for in all
elevation calculations.
"""

import math
from typing import Optional

STANDARD_TEMP_F = 59.0
STANDARD_ALTITUDE_FT = 0.0
GRAVITY_FPS2 = 32.174


def air_density_ratio(altitude_ft: float, temp_f: float) -> float:
    """Ratio of air density at given conditions vs standard sea-level 59 °F."""
    temp_r = temp_f + 459.67
    std_temp_r = STANDARD_TEMP_F + 459.67
    pressure_ratio = (1.0 - 6.87559e-6 * altitude_ft) ** 5.2561
    return pressure_ratio * (std_temp_r / temp_r)


def _g7_cd(mach: float) -> float:
    """G7 standard-projectile drag coefficient."""
    if mach < 0.7:
        return 0.1198
    elif mach < 0.9:
        return 0.1197
    elif mach < 1.0:
        return 0.1200
    else:
        return 0.1500


def _g1_cd(mach: float) -> float:
    """G1 standard-projectile drag coefficient."""
    if mach < 0.6:
        return 0.2629
    elif mach < 0.7:
        return 0.2782
    elif mach < 0.8:
        return 0.3101
    elif mach < 0.9:
        return 0.3702
    elif mach < 1.0:
        return 0.4485
    elif mach < 1.1:
        return 0.5150
    elif mach < 1.2:
        return 0.5203
    elif mach < 1.3:
        return 0.5078
    elif mach < 1.5:
        return 0.4775
    elif mach < 1.7:
        return 0.4483
    else:
        return 0.4037


def drop_inches(
    muzzle_velocity_fps: float,
    bc: float,
    distance_yards: float,
    altitude_ft: float = 0.0,
    temp_f: float = 59.0,
    bc_model: str = "g7",
) -> float:
    """
    Bullet drop in inches at distance (gravity only, relative to bore line).
    Uses G7 or G1 drag model depending on bc_model.
    """
    density_ratio = air_density_ratio(altitude_ft, temp_f)
    bc_eff = bc / density_ratio
    cd_fn = _g7_cd if bc_model == "g7" else _g1_cd

    v = muzzle_velocity_fps
    step_yd = 0.5
    step_ft = step_yd * 3.0
    drop_ft = 0.0
    drop_vel = 0.0
    total_yards = 0.0

    while total_yards < distance_yards:
        dt = step_ft / max(v, 1.0)
        mach = v / 1116.45
        cd = cd_fn(mach)
        decel = (0.5 * cd * v * v) / (bc_eff * 1116.45 * 1116.45)
        v = max(v - decel * step_ft, 1.0)

        drop_vel += GRAVITY_FPS2 * dt
        drop_ft += drop_vel * dt + 0.5 * GRAVITY_FPS2 * dt * dt
        total_yards += step_yd

    return drop_ft * 12.0  # inches


def _trajectory_mils(
    drop_d: float,
    drop_z: float,
    dist_yards: float,
    zero_yards: float,
    sight_height_in: float,
) -> float:
    """
    Elevation adjustment in MIL at dist_yards given drops (inches) and sight height.

    Accounts for the barrel-to-scope offset so near-distance crossovers and
    far-distance predictions are geometrically correct.
    """
    if dist_yards <= 0:
        return 0.0
    # Height of bullet relative to LOS at dist_yards:
    #   δ = drop_d − (drop_z − h) × (d/z) − h
    h = sight_height_in
    z = zero_yards
    d = dist_yards
    delta = drop_d - (drop_z - h) * (d / z) - h
    # 1 MIL at d yards = d × 36/1000 inches
    return -delta / (d * 36.0 / 1000.0)


def calculate_trajectory(
    muzzle_velocity_fps: float,
    bc: float,
    zero_distance_yards: float,
    distances_yards: list[float],
    altitude_ft: float = 0.0,
    temp_f: float = 59.0,
    bc_model: str = "g7",
    sight_height_in: float = 1.5,
) -> dict[float, float]:
    """
    MIL adjustments for a list of distances at given conditions.
    Positive = dial up. Accounts for sight height and zero geometry.
    """
    drop_z = drop_inches(muzzle_velocity_fps, bc, zero_distance_yards,
                         altitude_ft, temp_f, bc_model)

    results: dict[float, float] = {}
    for dist in distances_yards:
        if dist == 0:
            results[dist] = 0.0
            continue
        drop_d = drop_inches(muzzle_velocity_fps, bc, dist,
                             altitude_ft, temp_f, bc_model)
        results[dist] = round(
            _trajectory_mils(drop_d, drop_z, dist, zero_distance_yards, sight_height_in), 1
        )
    return results


def _entry_bias(
    entry: dict,
    muzzle_velocity_fps: float,
    bc: float,
    zero_distance_yards: float,
    match_altitude_ft: float,
    match_temp_f: float,
    bc_model: str = "g7",
    sight_height_in: float = 1.5,
) -> float:
    """
    Residual between observed adjustment and model at the range conditions
    recorded in the entry (falls back to match-day conditions if absent).
    """
    range_temp = entry.get("temp_f", match_temp_f)
    range_alt = entry.get("altitude_ft", match_altitude_ft)

    model = calculate_trajectory(
        muzzle_velocity_fps, bc, zero_distance_yards,
        [entry["distance"]], range_alt, range_temp, bc_model, sight_height_in,
    )[entry["distance"]]

    return entry["adjustment"] - model


def interpolate_dope(
    dope_entries: list[dict],
    target_distance: float,
    muzzle_velocity_fps: float,
    bc: float,
    zero_distance_yards: float,
    altitude_ft: float = 0.0,
    temp_f: float = 59.0,
    bc_model: str = "g7",
    sight_height_in: float = 1.5,
) -> float:
    """
    MIL adjustment for target_distance at match-day conditions.

    Uses bias-correction: residuals from observed DOPE entries (computed at
    their own range conditions) are interpolated and added to the match-day model.
    """
    match_day = calculate_trajectory(
        muzzle_velocity_fps, bc, zero_distance_yards,
        [target_distance], altitude_ft, temp_f, bc_model, sight_height_in,
    )[target_distance]

    if not dope_entries:
        return match_day

    biased = sorted(
        [
            {**e, "_bias": _entry_bias(
                e, muzzle_velocity_fps, bc, zero_distance_yards,
                altitude_ft, temp_f, bc_model, sight_height_in,
            )}
            for e in dope_entries
        ],
        key=lambda e: e["distance"],
    )

    for e in biased:
        if e["distance"] == target_distance:
            return round(match_day + e["_bias"], 1)

    lower = upper = None
    for e in biased:
        if e["distance"] < target_distance:
            lower = e
        elif e["distance"] > target_distance and upper is None:
            upper = e

    if lower and upper:
        frac = (target_distance - lower["distance"]) / (upper["distance"] - lower["distance"])
        interp_bias = lower["_bias"] + frac * (upper["_bias"] - lower["_bias"])
        return round(match_day + interp_bias, 1)

    nearest = lower if lower else upper
    return round(match_day + nearest["_bias"], 1)
