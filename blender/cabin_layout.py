"""cabin_layout.py - every dimension of the Stargaze cabin, in one place (metres; Blender frame: +Z up, +Y forward,
+X starboard / right). The web app reads the exported markers (eye spots, radio, lamps), never these numbers.

The cabin is a capsule: an elliptic cylinder (living area, behind) joined at YJ to a half-ellipsoid glass canopy
(front). Floor at z = 0. The pilot sits at the origin facing +Y.
"""
import math

import numpy as np

DEG = math.pi / 180.0

# ---------------------------------------------------------------------------------------------- capsule envelope
A = 1.50          # half-width of the section (x)
B = 1.52          # half-height of the section (z)
ZC = 0.92         # section centre height
YJ = -0.45        # junction plane: canopy in front, cylinder behind
CF = 1.95         # front semi-axis of the canopy ellipsoid (tip at YJ + CF)
YB = -2.55        # back wall (inner face)
ZS = 0.96         # canopy sill height: glass above, lining below
T_LINING = 0.05   # wall lining thickness
T_GLASS = 0.012
FLOOR_T = 0.06
EMBED = 0.02      # how far panels run into their neighbours

THETA_F = math.acos(-ZC / B)                     # section angle (from the top) where the cylinder meets the floor
MU_C = math.acos(ZC / B)                          # canopy latitude where the ellipsoid bottom leaves the floor
MU_GLASS_MAX = 88.0 * DEG                         # glass ends here (the tip is below the sill beam)


def section_xz(theta):
    """point on the cylinder section at angle theta from the top (theta > 0 = starboard)"""
    return A * np.sin(theta), ZC + B * np.cos(theta)


def ellipsoid(mu, lam):
    """canopy ellipsoid: mu = latitude from the junction plane (0) toward the tip (pi/2), lam = angle round the
    y axis from the top (0), positive to starboard"""
    mu = np.asarray(mu, np.float64)
    lam = np.asarray(lam, np.float64)
    return np.stack(np.broadcast_arrays(A * np.cos(mu) * np.sin(lam), YJ + CF * np.sin(mu) + 0 * lam,
                                        ZC + B * np.cos(mu) * np.cos(lam)), -1)


def ellipsoid_normal_in(p):
    """unit normal pointing INTO the cabin at an ellipsoid point"""
    p = np.asarray(p, np.float64)
    g = np.stack([p[..., 0] / A ** 2, (p[..., 1] - YJ) / CF ** 2, (p[..., 2] - ZC) / B ** 2], -1)
    g /= np.linalg.norm(g, axis=-1, keepdims=True)
    return -g


def cylinder_normal_in(theta):
    x, z = section_xz(theta)
    g = np.stack([x / A ** 2, 0 * x, (z - ZC) / B ** 2], -1)
    g /= np.linalg.norm(g, axis=-1, keepdims=True)
    return -g


def lam_at_z(mu, z):
    """|lam| where the canopy at latitude mu reaches height z (nan if it never does)"""
    c = (z - ZC) / (B * np.cos(mu))
    with np.errstate(invalid="ignore"):
        return np.arccos(np.clip(c, -1.0, 1.0)) + np.where(np.abs(c) > 1.0, np.nan, 0.0)


def sill_lam(mu):
    return lam_at_z(mu, ZS)


def wall_x_at_z(z):
    """half-width of the cylinder section at height z"""
    t = (z - ZC) / B
    return A * math.sqrt(max(0.0, 1.0 - t * t))


# ---------------------------------------------------------------------------------------------- canopy frame
ARCH_MUS = (30.0 * DEG, 58.0 * DEG)               # nested arches (the junction arch is mu = 0)
MULLIONS = ((0.0, 0.0, 30.0 * DEG),                # (lam, mu0, mu1): overhead spine only between the first arches
            (38.0 * DEG, 0.0, 58.0 * DEG), (-38.0 * DEG, 0.0, 58.0 * DEG),
            (70.0 * DEG, 0.0, 58.0 * DEG), (-70.0 * DEG, 0.0, 58.0 * DEG))
RIB_W = 0.05      # rib width along the surface
RIB_IN = 0.035    # how far a rib stands into the cabin from the glass surface
RIB_OUT = 0.045   # and out past it
JUNCTION_W = 0.13
JUNCTION_IN = 0.055
SILL_W = 0.11     # sill beam: width along the surface normal plane
SILL_H = 0.075

# ---------------------------------------------------------------------------------------------- pilot + console
EYE = (0.0, 0.02, 1.17)                            # pilot eye (Blender coords)
SEAT_AXIS = (0.0, -0.06)                           # swivel axis of the pilot seat (x, y)
CONSOLE_C = (0.0, 0.0)                             # centre of the console arcs (plan)
DESK_Z = 0.74
DESK_T = 0.034
DESK_R0 = 0.60                                     # inner (pilot) edge radius
DESK_R1 = 1.02                                     # back edge, where the instrument binnacle rises
DESK_SPAN = 82.0 * DEG                             # half angle of the desk arc (0 = forward)
BINNACLE_SPAN = 82.0 * DEG
BINNACLE_TOP = 0.925
BINNACLE_LEAN = 13.0 * DEG
BINNACLE_T = 0.06
DECK_Z = 0.948                                     # window-sill deck between the binnacle and the glass
KNEE_SPAN = 34.0 * DEG                             # open knee well either side of forward
SCREENS = ((-31.0 * DEG, "Screen_L"), (0.0, "Screen_C"), (31.0 * DEG, "Screen_R"))
SCREEN_W = 0.30
SCREEN_H = 0.15

# ---------------------------------------------------------------------------------------------- living area
NOOK_Y = (-2.12, -0.78)                            # port bench
NOOK_SEAT_Z = 0.44
NOOK_DEPTH = 0.56
GALLEY_Y = (-2.12, -0.78)                          # starboard counter
GALLEY_Z = 0.92                                    # counter top (the dado rail dies into its end)
GALLEY_DEPTH = 0.56
SHELF_Z = 1.74
PORTHOLE_PORT = (-1.42, 1.28, 0.23, 0.25)          # (y, z, half width, half height) oval in the wall
PORTHOLE_STBD = (-1.45, 1.30, 0.19, 0.19)
DOOR = (0.0, 0.12, 0.72, 1.82, 0.22)               # (x centre, sill z, width, height, corner radius) in the back wall
PENDANT = (0.0, -1.55, 1.98)                       # bottom of the pendant shade
RUG = (0.0, -1.48, 0.78)                           # centre x, y, radius
RAIL_Z = 0.90                                      # dado rail: wood panelling below, painted wall above
PORTHOLE_FLANGE = 0.075                            # brass flange width round each porthole opening
CEILING_PAINT_THETA = 0.62                         # section angle from the top: ceiling planks above, paint below


def rail_theta():
    """section angle of the dado rail (the paint / panelling boundary)"""
    return math.acos((RAIL_Z - ZC) / B)


def canopy_r_at(phi, z):
    """plan distance from the console centre (0, 0) to the inner hull at compass bearing phi and height z: the canopy
    ellipsoid in front of YJ, the cylinder behind it"""
    q = 1.0 - ((z - ZC) / B) ** 2
    if q <= 0:
        return 0.0
    s, c = math.sin(phi), math.cos(phi)
    qa = (s / A) ** 2 + (c / CF) ** 2
    qb = -2.0 * c * YJ / CF ** 2
    qc = (YJ / CF) ** 2 - q
    r = (-qb + math.sqrt(max(0.0, qb * qb - 4 * qa * qc))) / (2 * qa)
    if r * c < YJ and abs(s) > 1e-9:                # behind the junction: the cylinder wall
        r = A * math.sqrt(q) / abs(s)
    return r


def floor_outline(n_front=48):
    """closed CCW plan outline of the floor (inner faces of the lining at z = 0)"""
    x0 = wall_x_at_z(0.0)
    pts = [(-x0, YB), (x0, YB)]
    mus = np.linspace(0.0, MU_C, n_front)
    lam_f = lam_at_z(mus, 0.0)                     # angle from the top down to the floor
    right = [(A * math.cos(m) * math.sin(l), YJ + CF * math.sin(m)) for m, l in zip(mus, lam_f)]
    pts += right
    pts += [(-x, y) for x, y in reversed(right[:-1])]
    return np.asarray(pts)
