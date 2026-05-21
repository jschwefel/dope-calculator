"""
Ballistic calculations for the DOPE calculator.

Supports G1 and G7 drag models with environmental corrections for
temperature, altitude, and wind. Sight height is accounted for in all
elevation calculations. Wind produces both headwind/tailwind (elevation)
and crosswind (windage) effects.
"""

import math
from typing import Optional

STANDARD_TEMP_F    = 59.0
STANDARD_ALTITUDE_FT = 0.0
GRAVITY_FPS2       = 32.174
SPEED_OF_SOUND_FPS = 1116.45


def air_density_ratio(altitude_ft: float, temp_f: float) -> float:
    """Ratio of air density at given conditions vs standard sea-level 59 °F."""
    temp_r     = temp_f + 459.67
    std_temp_r = STANDARD_TEMP_F + 459.67
    pressure_ratio = (1.0 - 6.87559e-6 * altitude_ft) ** 5.2561
    return pressure_ratio * (std_temp_r / temp_r)


def _g7_cd(mach: float) -> float:
    """G7 standard-projectile drag coefficient."""
    if mach < 0.7:  return 0.1198
    if mach < 0.9:  return 0.1197
    if mach < 1.0:  return 0.1200
    return 0.1500


def _g1_cd(mach: float) -> float:
    """G1 standard-projectile drag coefficient."""
    if mach < 0.6:  return 0.2629
    if mach < 0.7:  return 0.2782
    if mach < 0.8:  return 0.3101
    if mach < 0.9:  return 0.3702
    if mach < 1.0:  return 0.4485
    if mach < 1.1:  return 0.5150
    if mach < 1.2:  return 0.5203
    if mach < 1.3:  return 0.5078
    if mach < 1.5:  return 0.4775
    if mach < 1.7:  return 0.4483
    return 0.4037


def wind_components(speed_fps: float, angle_deg: float) -> tuple[float, float]:
    """
    Decompose wind into head/crosswind components.

    Convention (matches UI):
      0°  = headwind   (blowing from downrange toward shooter)
      90° = R→L crosswind
      180°= tailwind
      270°= L→R crosswind

    Returns (headwind_fps, crosswind_fps):
      headwind_fps  > 0 opposes bullet travel (increases relative airspeed, more drag)
      crosswind_fps > 0 pushes bullet left → correction = dial right (positive windage)
    """
    rad = math.radians(angle_deg)
    return speed_fps * math.cos(rad), speed_fps * math.sin(rad)


def _integrate(
    muzzle_velocity_fps: float,
    bc_eff: float,
    cd_fn,
    distance_yards: float,
    headwind_fps: float = 0.0,
) -> tuple[float, float]:
    """
    Core numerical integrator (0.5-yd steps).
    Returns (drop_ft, time_of_flight_s).
    headwind_fps > 0 increases drag; < 0 decreases drag (tailwind).
    """
    v         = muzzle_velocity_fps
    step_yd   = 0.5
    step_ft   = step_yd * 3.0
    drop_ft   = 0.0
    drop_vel  = 0.0
    t_flight  = 0.0
    total_yd  = 0.0

    while total_yd < distance_yards:
        dt    = step_ft / max(v, 1.0)                  # time step from ground velocity
        v_rel = max(v + headwind_fps, 1.0)              # velocity relative to air
        mach  = v_rel / SPEED_OF_SOUND_FPS
        cd    = cd_fn(mach)
        decel = (0.5 * cd * v_rel * v_rel) / (bc_eff * SPEED_OF_SOUND_FPS ** 2)
        v     = max(v - decel * step_ft, 1.0)

        t_flight += dt
        drop_vel += GRAVITY_FPS2 * dt
        drop_ft  += drop_vel * dt + 0.5 * GRAVITY_FPS2 * dt * dt
        total_yd += step_yd

    return drop_ft, t_flight


def drop_inches(
    muzzle_velocity_fps: float,
    bc: float,
    distance_yards: float,
    altitude_ft: float = 0.0,
    temp_f: float = 59.0,
    bc_model: str = "g7",
    headwind_fps: float = 0.0,
) -> float:
    """Bullet drop in inches at distance (gravity only, relative to bore line)."""
    density_ratio = air_density_ratio(altitude_ft, temp_f)
    bc_eff = bc / density_ratio
    cd_fn  = _g7_cd if bc_model == "g7" else _g1_cd
    drop_ft, _ = _integrate(muzzle_velocity_fps, bc_eff, cd_fn, distance_yards, headwind_fps)
    return drop_ft * 12.0


def _trajectory_mils(
    drop_d: float,
    drop_z: float,
    dist_yards: float,
    zero_yards: float,
    sight_height_in: float,
) -> float:
    """
    Elevation adjustment in MIL. Geometrically accounts for barrel-to-scope offset.
    drop_d and drop_z are in feet (from _integrate). sight_height_in is in inches.
    Returns exactly 0.0 at the zero distance. Positive = dial up.
    """
    if dist_yards <= 0:
        return 0.0
    h_ft  = sight_height_in / 12.0
    scale = dist_yards / zero_yards
    needed_ft = drop_d + h_ft - scale * (drop_z + h_ft)
    return (needed_ft * 12.0) / (dist_yards * 36.0 / 1000.0)


def _windage_mils(
    crosswind_fps: float,
    tof_s: float,
    distance_yards: float,
    muzzle_velocity_fps: float,
) -> float:
    """
    Lateral (windage) correction in MIL using the Didion lag-rule.
    Positive = dial right. Negative = dial left.
    """
    if distance_yards <= 0 or crosswind_fps == 0.0:
        return 0.0
    t_vacuum   = (distance_yards * 3.0) / max(muzzle_velocity_fps, 1.0)
    drift_in   = crosswind_fps * (tof_s - t_vacuum) * 12.0
    return drift_in / (distance_yards * 36.0 / 1000.0)


def calculate_trajectory(
    muzzle_velocity_fps: float,
    bc: float,
    zero_distance_yards: float,
    distances_yards: list[float],
    altitude_ft: float = 0.0,
    temp_f: float = 59.0,
    bc_model: str = "g7",
    sight_height_in: float = 1.5,
    wind_speed_fps: float = 0.0,
    wind_angle_deg: float = 0.0,
) -> dict[float, dict]:
    """
    Compute elevation and windage adjustments for a list of distances.
    Returns {distance: {"elevation": mils, "windage": mils}}.
    Positive elevation = dial up. Positive windage = dial right.
    """
    hw, cw = wind_components(wind_speed_fps, wind_angle_deg)

    density_ratio = air_density_ratio(altitude_ft, temp_f)
    bc_eff = bc / density_ratio
    cd_fn  = _g7_cd if bc_model == "g7" else _g1_cd

    drop_z, _ = _integrate(muzzle_velocity_fps, bc_eff, cd_fn, zero_distance_yards, hw)

    results: dict[float, dict] = {}
    for dist in distances_yards:
        if dist == 0:
            results[dist] = {"elevation": 0.0, "windage": 0.0}
            continue
        drop_d, tof = _integrate(muzzle_velocity_fps, bc_eff, cd_fn, dist, hw)
        elev = _trajectory_mils(drop_d, drop_z, dist, zero_distance_yards, sight_height_in)
        wind = _windage_mils(cw, tof, dist, muzzle_velocity_fps)
        results[dist] = {"elevation": elev, "windage": wind}
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
    Residual between observed elevation and calm-weather model at range conditions.
    Wind is not applied here — observed DOPE reflects real rifle behaviour in calm conditions.
    """
    range_temp = entry.get("temp_f", match_temp_f)
    range_alt  = entry.get("altitude_ft", match_altitude_ft)

    model_elev = calculate_trajectory(
        muzzle_velocity_fps, bc, zero_distance_yards,
        [entry["distance"]], range_alt, range_temp, bc_model, sight_height_in,
    )[entry["distance"]]["elevation"]

    return entry["adjustment"] - model_elev


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
    wind_speed_fps: float = 0.0,
    wind_angle_deg: float = 0.0,
) -> dict:
    """
    Elevation and windage for target_distance at match-day conditions.
    Returns {"elevation": mils, "windage": mils}.

    Elevation uses bias-correction from observed DOPE entries.
    Windage is purely physical (no bias correction).
    """
    match_day = calculate_trajectory(
        muzzle_velocity_fps, bc, zero_distance_yards,
        [target_distance], altitude_ft, temp_f, bc_model, sight_height_in,
        wind_speed_fps, wind_angle_deg,
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
            return {"elevation": round(match_day["elevation"] + e["_bias"], 1),
                    "windage":   match_day["windage"]}

    lower = upper = None
    for e in biased:
        if e["distance"] < target_distance:
            lower = e
        elif e["distance"] > target_distance and upper is None:
            upper = e

    if lower and upper:
        frac        = (target_distance - lower["distance"]) / (upper["distance"] - lower["distance"])
        interp_bias = lower["_bias"] + frac * (upper["_bias"] - lower["_bias"])
        return {"elevation": round(match_day["elevation"] + interp_bias, 1),
                "windage":   match_day["windage"]}

    nearest = lower if lower else upper
    return {"elevation": round(match_day["elevation"] + nearest["_bias"], 1),
            "windage":   match_day["windage"]}
