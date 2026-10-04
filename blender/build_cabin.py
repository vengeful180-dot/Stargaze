"""build_cabin.py - builds the Stargaze cabin from cabin_layout (Blender 5.2: bpy + numpy).

    blender -b --factory-startup --python-exit-code 1 -P blender/build_cabin.py -- --out blender/out/cabin_geo.blend
        [--glb blender/out/cabin_blockout.glb] [--report blender/out/build.json]

Every part is a closed, outward-wound solid (meshkit.Part.finalize + a signed-volume and open-edge gate here).
Parts that rest on or hang from another are sunk into it by construction; cabin_checks.py measures every mount.
Face attribute `zone` (int) names the material zone (ZONES), `lgroup` the light group of emissive faces.
"""
import argparse
import json
import math
import os
import sys
import zlib

import bmesh
import bpy
import numpy as np
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cabin_layout as L  # noqa: E402
import meshkit as K  # noqa: E402
import build_props as PR  # noqa: E402

from build_cabin_zones import GROUPS, ZONES  # noqa: E402
DEG = math.pi / 180.0


# ============================================================================================== shell
def insert_samples(base, values, min_gap):
    """sorted samples containing every value exactly; base samples closer than min_gap to one are dropped"""
    base = np.asarray(base, np.float64)
    vals = np.asarray(sorted(values), np.float64)
    keep = [x for x in base if np.min(np.abs(vals - x)) >= min_gap]
    return np.unique(np.concatenate([keep, vals]))


def porthole_windows():
    """(y0, y1, th0, th1, porthole) rectangles of the lining replaced by finely meshed panels round each porthole"""
    out = []
    for (yc, zc, hw, hh), side, name in ((L.PORTHOLE_PORT, -1, "Port"), (L.PORTHOLE_STBD, 1, "Stbd")):
        fl = L.PORTHOLE_FLANGE
        z0, z1 = zc - hh - fl - 0.03, zc + hh + fl + 0.03
        assert z0 > L.RAIL_Z + 0.02, "a porthole panel must sit above the dado rail"
        t0, t1 = sorted((side * math.acos((z0 - L.ZC) / L.B), side * math.acos((z1 - L.ZC) / L.B)))
        out.append((-1.75, -1.09, t0, t1, (yc, zc, hw, hh, side, name)))
    return out


def lining_zone(th):
    th = abs(th)
    return "ceiling_wood" if th < L.CEILING_PAINT_THETA else ("wall_paint" if th < L.rail_theta() else "wall_wood")


def lining_S(y, th):
    x, z = L.section_xz(th)
    return (x, y, z)


def lining_N(y, th):
    return L.cylinder_normal_in(np.array(th))


def build_lining():
    """walls + ceiling of the living area (cylinder). Exact sample lines at the paint / panelling boundary (under the
    dado rail), the ceiling boundary and round each porthole window (filled by build_porthole_panels)."""
    P = K.Part("Shell_Lining", "wall_wood")
    th_f = L.THETA_F + 0.03
    wins = porthole_windows()
    special = [L.rail_theta(), -L.rail_theta(), L.CEILING_PAINT_THETA, -L.CEILING_PAINT_THETA]
    for _, _, t0, t1, _ in wins:
        special += [t0, t1]
    thetas = insert_samples(np.linspace(-th_f, th_f, 129), special, 0.012)
    ys = insert_samples(np.linspace(L.YB - L.EMBED, L.YJ + L.EMBED, 45), [-1.75, -1.09], 0.015)

    def keep(i, j):
        y = 0.5 * (ys[i] + ys[i + 1])
        th = 0.5 * (thetas[j] + thetas[j + 1])
        return not any(y0 < y < y1 and t0 < th < t1 for y0, y1, t0, t1, _ in wins)

    K.thick_patch(P, lining_S, lining_N, ys, thetas, L.T_LINING, keep,
                  lambda i, j: lining_zone(0.5 * (thetas[j] + thetas[j + 1])))
    return K.compact(P)


def build_porthole_panels():
    """the lining round each porthole on a ~1 cm grid with an elliptical opening: wider than the porthole's barrel,
    narrower than its flange (a 5 cm grid's staircase showed past the flange)"""
    parts = []
    for y0, y1, t0, t1, (yc, zc, hw, hh, side, name) in porthole_windows():
        P = K.Part(f"Shell_PortholePanel_{name}", "wall_paint")
        tc = side * math.acos((zc - L.ZC) / L.B)
        ds = math.hypot(L.A * math.cos(tc), L.B * math.sin(tc))
        ys = np.linspace(y0, y1, int((y1 - y0) / 0.011) + 1)
        ths = np.linspace(t0, t1, int((t1 - t0) * ds / 0.011) + 1)
        r_cut = 0.5 * (1.06 + 1.0 + L.PORTHOLE_FLANGE / max(hw, hh))        # between barrel (1.06) and flange

        def keep(i, j):
            y = 0.5 * (ys[i] + ys[i + 1])
            th = 0.5 * (ths[j] + ths[j + 1])
            return ((y - yc) / hw) ** 2 + ((th - tc) * ds / hh) ** 2 > r_cut ** 2

        K.thick_patch(P, lining_S, lining_N, ys, ths, L.T_LINING, keep, lambda i, j: "wall_paint")
        parts.append(K.compact(P))
    return parts


def build_lower_front():
    """the lining below the sill in the canopy half: two side pieces down to the floor, and the chin in front"""
    parts = []
    mu_c = math.acos((L.ZC + L.EMBED) / L.B)
    for side in (1, -1):
        P = K.Part("Shell_Lower_" + ("R" if side > 0 else "L"), "wall_wood")
        mus = np.linspace(-0.012, mu_c, 40)
        ss = np.linspace(0.0, 1.0, 26)

        def lam(mu, s, side=side):
            top = float(L.lam_at_z(mu, L.ZS + L.EMBED))
            bot = float(L.lam_at_z(mu, -L.EMBED))
            return side * (top + s * (bot - top))

        def S(mu, s):
            return L.ellipsoid(mu, lam(mu, s))

        def N(mu, s):
            return L.ellipsoid_normal_in(S(mu, s))

        K.thick_patch(P, S, N, mus, ss, L.T_LINING)
        parts.append(K.compact(P))
    P = K.Part("Shell_Chin", "wall_wood")
    mus = np.linspace(mu_c, 80.0 * DEG, 24)
    ss = np.linspace(0.0, 1.0, 49)

    def lamc(mu, s):
        top = float(L.lam_at_z(mu, L.ZS + L.EMBED))
        return top + s * (2 * math.pi - 2 * top)

    K.thick_patch(P, lambda mu, s: L.ellipsoid(mu, lamc(mu, s)), lambda mu, s: L.ellipsoid_normal_in(L.ellipsoid(mu, lamc(mu, s))),
                mus, ss, L.T_LINING)
    parts.append(K.compact(P))
    return parts


def build_floor():
    P = K.Part("Shell_Floor", "floor_wood")
    o = L.floor_outline(48)
    # grow the outline under the lining so the walls stand on it
    c = o.mean(0)
    d = o - c
    o2 = c + d * (1.0 + (L.T_LINING + 0.03) / np.linalg.norm(d, axis=1, keepdims=True))
    K.extrude_outline(P, o2, -L.FLOOR_T, 0.0, zone="floor_wood")
    return P


def resample_closed(o, n):
    """n points evenly spaced by arc length round a closed 2D polygon"""
    o = np.asarray(o, np.float64)
    seg = np.linalg.norm(np.roll(o, -1, 0) - o, axis=1)
    cum = np.concatenate([[0.0], np.cumsum(seg)])
    t = np.linspace(0, cum[-1], n, endpoint=False)
    out = []
    for u in t:
        i = min(np.searchsorted(cum, u, side="right") - 1, len(o) - 1)
        f = (u - cum[i]) / max(seg[i], 1e-12)
        out.append(o[i] + f * (o[(i + 1) % len(o)] - o[i]))
    return np.asarray(out)


def build_back_wall():
    P = K.Part("Shell_Back", "wall_wood_b")
    dx, dz, dw, dh, dr = L.DOOR
    door = resample_closed(K.rounded_rect(dw, dh, dr, 8), 128)     # evenly along the straight sides too (rays from
    door[:, 1] += dz + dh / 2                                      # corner points alone cut chords across the wall)
    door[:, 0] += dx
    cz = dz + dh / 2
    outer = []
    for x, z in door:
        d = np.array([x - dx, z - cz])
        d /= np.linalg.norm(d)
        # ray from the door centre to the section ellipse (extended below the floor)
        a_ = (d[0] / L.A) ** 2 + (d[1] / L.B) ** 2
        b_ = 2 * (d[1] * (cz - L.ZC) / L.B ** 2)
        c_ = ((cz - L.ZC) / L.B) ** 2 - 1
        t = (-b_ + math.sqrt(b_ * b_ - 4 * a_ * c_)) / (2 * a_)
        p = np.array([dx, cz]) + d * (t + L.EMBED)
        if p[1] < -L.EMBED:
            t2 = (-L.EMBED - cz) / d[1]
            p = np.array([dx, cz]) + d * t2
        outer.append(p)
    outer = np.asarray(outer)
    n = len(door)
    y0, y1 = L.YB, L.YB - 0.06
    bi = P.vs([(x, y0, z) for x, z in door])
    bo = P.vs([(x, y0, z) for x, z in outer])
    bi2 = P.vs([(x, y1, z) for x, z in door])
    bo2 = P.vs([(x, y1, z) for x, z in outer])
    for j in range(n):
        j2 = (j + 1) % n
        P.f((bi + j, bo + j, bo + j2, bi + j2), "wall_wood_b")
        P.f((bi2 + j, bi2 + j2, bo2 + j2, bo2 + j), "hidden")
        P.f((bo + j, bo2 + j, bo2 + j2, bo + j2), "hidden")
        P.f((bi + j, bi + j2, bi2 + j2, bi2 + j), "wall_wood_b")
    return P


def build_junction():
    """the structural arch where canopy meets cabin: runs round the whole section, floor to floor"""
    P = K.Part("Frame_Junction", "walnut")
    th_f = L.THETA_F + 0.02
    th = np.linspace(-th_f, th_f, 140)
    x, z = L.section_xz(th)
    path = np.column_stack([x, np.full_like(x, L.YJ), z])
    nrm = L.cylinder_normal_in(th)
    sec = K.rounded_rect(L.JUNCTION_IN + 0.03, L.JUNCTION_W, 0.012, 3)
    sec[:, 0] += (L.JUNCTION_IN - 0.03) / 2      # from 3 cm inside the wall to JUNCTION_IN into the room
    K.sweep(P, path, sec, frames=K.section_frames(path, nrm), zone_fn=lambda j: "walnut")
    return P


def build_sill():
    P = K.Part("Frame_Sill", "oak")
    k = (L.ZS - L.ZC) / L.B
    a_ = L.A * math.sqrt(1 - k * k)
    c_ = L.CF * math.sqrt(1 - k * k)
    al = np.linspace(-0.5 * math.pi - 0.02, 0.5 * math.pi + 0.02, 120)
    path = np.column_stack([a_ * np.sin(al), L.YJ + c_ * np.cos(al), np.full_like(al, L.ZS)])
    nrm = L.ellipsoid_normal_in(path)
    nrm[:, 2] = 0
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    sec = K.rounded_rect(L.SILL_W, L.SILL_H, 0.015, 3)
    sec[:, 0] += L.SILL_W / 2 - 0.035
    K.sweep(P, path, sec, frames=K.section_frames(path, nrm), zone_fn=lambda j: "oak")
    return P


def rib(name, path, nrm, w, zone="bronze"):
    P = K.Part(name, zone)
    sec = K.rounded_rect(L.RIB_IN + L.RIB_OUT, w, 0.008, 3)
    sec[:, 0] += (L.RIB_IN - L.RIB_OUT) / 2
    K.sweep(P, path, sec, frames=K.section_frames(path, nrm), zone_fn=lambda j: zone)
    return P


def build_canopy_frame():
    parts = []
    for k, mu in enumerate(L.ARCH_MUS):
        top = float(L.lam_at_z(mu, L.ZS - 0.02))
        lam = np.linspace(-top, top, 96)
        path = L.ellipsoid(np.full_like(lam, mu), lam)
        parts.append(rib(f"Frame_Arch_{k + 1}", path, L.ellipsoid_normal_in(path), L.RIB_W))
    for k, (lam, mu0, mu1) in enumerate(L.MULLIONS):
        mus = np.linspace(mu0, mu1, 40)
        path = L.ellipsoid(mus, np.full_like(mus, lam))
        parts.append(rib(f"Frame_Mullion_{k + 1}", path, L.ellipsoid_normal_in(path), L.RIB_W * 0.8))
    return parts


def build_glass():
    P = K.Part("Glass_Canopy", "glass")
    mus = np.linspace(-0.01, L.MU_GLASS_MAX, 72)
    ss = np.linspace(-1.0, 1.0, 97)

    def lam(mu, s):
        return s * float(L.lam_at_z(mu, L.ZS - 0.02))

    def S(mu, s):
        p = L.ellipsoid(mu, lam(mu, s))
        return p - L.ellipsoid_normal_in(p) * 0.004      # glass sits just outside the rib faces' plane

    def N(mu, s):
        return L.ellipsoid_normal_in(L.ellipsoid(mu, lam(mu, s)))

    K.thick_patch(P, S, N, mus, ss, L.T_GLASS, zone_fn=lambda i, j: "glass", out_zone="glass", rim_zone="glass")
    return P


def porthole(name, yc, zc, hw, hh, side):
    """brass porthole: flange ring on the wall, barrel through the lining, glass pane"""
    th = side * math.acos((zc - L.ZC) / L.B)
    x, z = L.section_xz(th)
    n = L.cylinder_normal_in(np.array(th))
    p = np.array([x, yc, z])
    # local frame: z = into the room, x = along the cabin (y), y = up the wall
    up = np.cross(n, [0.0, 1.0, 0.0]) * (-side)
    M = K.frame(p, (0, 1, 0), up)
    M[:3, 2] = n
    ring = K.Part(name + "_Frame", "brass")
    # profile (r, z) along the local normal: barrel behind, flange in front, rolled edge
    r_open = 1.0
    fl = 1.0 + L.PORTHOLE_FLANGE / max(hw, hh)
    prof = [(r_open, -0.07), (r_open, 0.012), (r_open + 0.02, 0.022), (fl - 0.02, 0.022), (fl, 0.012), (fl, -0.004),
            (r_open + 0.06, -0.004), (r_open + 0.06, -0.07)]
    Msc = M @ np.diag([hw, hh, 1.0, 1.0])
    K.lathe(ring, prof, Msc, 56, lambda k: "brass")
    gl = K.Part(name + "_Glass", "glass")
    K.lathe(gl, [(0.0, -0.035), (r_open + 0.03, -0.035), (r_open + 0.03, -0.025), (0.0, -0.025)], Msc, 56,
            lambda k: "glass")
    return [ring, gl]


# ============================================================================================== console
def hull_outline(r0, a0, a1, z, rc=0.012, n_arc=48, n_corner=4):
    """closed plan outline of a block under the desk at height z: front arc at r0 (filleted corners), back along
    the hull (WALL_EMBED into the lining). Same point count at every z, so rings stack into a solid."""
    def pt(r, a):
        return (r * math.sin(a), r * math.cos(a))

    out = [pt(L.canopy_r_at(a, z) + PR.WALL_EMBED, a) for a in np.linspace(a0, a1, n_arc)]
    for k in range(0, n_corner):
        t = 0.5 * math.pi * k / n_corner
        r = r0 + rc - rc * math.sin(t)
        out.append(pt(r, a1 - (rc - rc * math.cos(t)) / r))
    for a in np.linspace(a1 - rc / r0, a0 + rc / r0, n_arc):
        out.append(pt(r0, a))
    for k in range(1, n_corner + 1):
        t = 0.5 * math.pi * k / n_corner
        r = r0 + rc - rc * math.cos(t)
        out.append(pt(r, a0 + (rc - rc * math.sin(t)) / r))
    out = np.asarray(out)
    area = 0.5 * np.sum(out[:, 0] * np.roll(out[:, 1], -1) - np.roll(out[:, 0], -1) * out[:, 1])
    return out if area > 0 else out[::-1]


def hull_block(name, r0, a0, a1, z0, z1, zone, rc=0.012, n_z=9):
    P = K.Part(name, zone)
    prof = [(0.0, z) for z in np.linspace(z0, z1, n_z)]
    K.outline_slab(P, lambda inset, z: hull_outline(r0, a0, a1, z, rc), prof, zone_fn=lambda k: zone)
    return P


def drawer(name, r_front, a0, a1, z0, z1, gap=0.012, proud=0.014, T=0.018):
    """a curved drawer front on a cabinet face (4 mm into it) with a brass knob at its centre"""
    P = K.Part(name, "walnut")
    r = r_front - proud
    g0, g1 = a0 + gap / r_front, a1 - gap / r_front
    us = np.linspace(g0, g1, 24)
    vs = np.linspace(z0, z1, 3)
    K.thick_patch(P, lambda a, z: (r * math.sin(a), r * math.cos(a), z), lambda a, z: (-math.sin(a), -math.cos(a), 0.0),
                  us, vs, T, zone_fn=lambda i, j: "walnut", out_zone="hidden")
    K.compact(P)
    am, zm = 0.5 * (g0 + g1), 0.5 * (z0 + z1)
    n = np.array([-math.sin(am), -math.cos(am), 0.0])
    xa = np.array([math.cos(am), -math.sin(am), 0.0])
    M = K.frame((r * math.sin(am), r * math.cos(am), zm), xa, np.cross(n, xa))
    M[:3, 2] = n
    K.lathe(P, [(0.0, -0.004), (0.008, -0.004), (0.008, 0.01), (0.013, 0.018), (0.011, 0.024), (0.0, 0.025)], M, 16,
            lambda k: "brass")
    return [P]


def build_console():
    parts = []
    span = L.DESK_SPAN
    # desk top: walnut slab with a round-over on the pilot edge
    desk = K.Part("Console_Desk", "walnut")
    prof = K.round_profile(L.DESK_T, 0.012, 4, top_only=False)

    def outline(inset):
        return K.sector_outline(L.DESK_R0, L.DESK_R1 + 0.05, -span, span, 0.05, inset, 72, 5)

    K.outline_slab(desk, outline, [(i, z + L.DESK_Z - L.DESK_T) for i, z in prof], zone_fn=lambda k: "walnut")
    parts.append(desk)

    # binnacle: a leaning instrument panel rising from the back of the desk
    bin_ = K.Part("Console_Binnacle", "panel_teal")
    phis = np.linspace(-L.BINNACLE_SPAN, L.BINNACLE_SPAN, 61)
    us = np.linspace(0.0, 1.0, 6)
    h = L.BINNACLE_TOP - (L.DESK_Z - 0.01)
    lean = math.tan(L.BINNACLE_LEAN)

    def S(u, phi):
        r = L.DESK_R1 - 0.02 + lean * h * u
        return (r * math.sin(phi), r * math.cos(phi), L.DESK_Z - 0.01 + h * u)

    def N(u, phi):
        n = np.array([-math.sin(phi), -math.cos(phi), lean])
        return n / np.linalg.norm(n)

    K.thick_patch(bin_, S, N, us, phis, L.BINNACLE_T, zone_fn=lambda i, j: "panel_teal")
    parts.append(K.compact(bin_))

    # window-sill deck from the binnacle top to the sill beam
    deck = K.Part("Console_Deck", "oak")
    def r_sill(phi):
        return L.canopy_r_at(phi, L.ZS)

    dphis = np.linspace(-85 * DEG, 85 * DEG, 85)
    r_in = L.DESK_R1 - 0.02 + lean * h + 0.01
    vs = np.linspace(0.0, 1.0, 5)

    def Sd(phi, v):
        r = r_in + v * (r_sill(phi) + 0.03 - r_in)
        return (r * math.sin(phi), r * math.cos(phi), L.DECK_Z)

    K.thick_patch(deck, Sd, lambda phi, v: (0.0, 0.0, 1.0), dphis, vs, 0.03, zone_fn=lambda i, j: "oak")
    parts.append(K.compact(deck))

    # cabinets under the wings and the knee-well back panel: their backs follow the hull (they used to run 30 cm
    # out through it at floor level); drawer fronts with brass knobs on the wings
    ztop = L.DESK_Z - L.DESK_T + 0.005
    r_cab = L.DESK_R0 + 0.035
    for side in (1, -1):
        tag = "R" if side > 0 else "L"
        a0, a1 = (L.KNEE_SPAN, span - 0.03) if side > 0 else (-span + 0.03, -L.KNEE_SPAN)
        parts.append(hull_block(f"Console_Cabinet_{tag}", r_cab, a0, a1, -0.01, ztop, "walnut"))
        for k, (z0, z1) in enumerate(((0.05, 0.34), (0.37, 0.66))):
            parts += drawer(f"Console_Drawer_{tag}{k + 1}", r_cab, a0, a1, z0, z1)
    parts.append(hull_block("Console_KneeWell", 0.98, -L.KNEE_SPAN - 0.01, L.KNEE_SPAN + 0.01, -0.01, ztop, "lining_dark",
                            rc=0.004))

    # under-glow strip along the desk's pilot edge
    strip = K.Part("Light_DeskStrip", "emit_strip")
    a = np.linspace(-span + 0.06, span - 0.06, 90)
    r = L.DESK_R0 + 0.03
    path = np.column_stack([r * np.sin(a), r * np.cos(a), np.full_like(a, L.DESK_Z - L.DESK_T - 0.004)])
    K.sweep(strip, path, K.rounded_rect(0.012, 0.012, 0.004, 2), up=(0, 0, 1), zone_fn=lambda j: "emit_strip",
            group="B")
    parts.append(strip)

    # screens: recessed 3 mm behind a brass bezel frame on the binnacle face
    for phi, name in L.SCREENS:
        u = 0.55
        r = L.DESK_R1 - 0.02 + lean * h * u
        p = np.array([r * math.sin(phi), r * math.cos(phi), L.DESK_Z - 0.01 + h * u])
        n = np.array([-math.sin(phi), -math.cos(phi), lean])
        n /= np.linalg.norm(n)
        xax = np.array([math.cos(phi), -math.sin(phi), 0.0])
        yax = np.cross(n, xax)
        M = K.frame(p, xax, yax)
        M[:3, 2] = n
        bez = K.Part(name + "_Bezel", "brass")
        K.frame_ring(bez, (L.SCREEN_W + 0.03, L.SCREEN_H + 0.03), (L.SCREEN_W - 0.004, L.SCREEN_H - 0.004), 0.008, 0.004,
                     -0.008, 0.014, M, "brass")
        parts.append(bez)
        scr = K.Part(name, "screen")
        K.box(scr, (L.SCREEN_W, L.SCREEN_H, 0.007), M @ K.translate((0, 0, 0.004)), "emit_screen", "B")
        parts.append(scr)
    return parts


# ============================================================================================== to Blender
def to_object(P, coll):
    P.finalize()
    zid = [ZONES.index(z) for z in P.zone]
    gid = [GROUPS.index(g) for g in P.group]
    me = bpy.data.meshes.new(P.name)
    piv = P.meta.get("pivot")
    V = P.V if piv is None else K.apply(np.linalg.inv(piv), P.V).tolist()
    me.from_pydata(V, [], P.F)
    me.attributes.new("zone", "INT", "FACE").data.foreach_set("value", np.array(zid, np.int32))
    me.attributes.new("lgroup", "INT", "FACE").data.foreach_set("value", np.array(gid, np.int32))
    seed = (zlib.crc32(P.name.encode()) % 10007) / 10007.0
    me.attributes.new("part_seed", "FLOAT", "FACE").data.foreach_set("value", np.full(len(P.F), seed, np.float32))
    me.shade_smooth()
    me.set_sharp_from_angle(angle=math.radians(35.0))
    if me.validate(verbose=False):
        raise RuntimeError(f"{P.name}: mesh.validate() had to fix the mesh - a builder bug")
    ob = bpy.data.objects.new(P.name, me)
    if piv is not None:
        ob.matrix_world = Matrix(piv.tolist())
        ob["pivot"] = True
    for k, v in P.meta.items():
        if k != "pivot":
            ob[k] = v
    coll.objects.link(ob)
    return ob


def mesh_stats(ob):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    open_e = sum(1 for e in bm.edges if not e.is_manifold)
    vol = bm.calc_volume(signed=True)
    tris = sum(len(f.verts) - 2 for f in bm.faces)
    zero = sum(1 for f in bm.faces if f.calc_area() < 1e-10)
    bm.free()
    return {"tris": tris, "volume": float(f"{vol:.4g}"), "open_edges": open_e, "zero_area": zero}


AREAS = {
    "Shell": lambda: [build_lining(), *build_porthole_panels(), *build_lower_front(), build_floor(), build_back_wall(),
                      build_junction(), build_sill()] + PR.wall_rails((L.GALLEY_Y[0] - 0.012, L.GALLEY_Y[1] + 0.012)),
    "Canopy": lambda: build_canopy_frame() + [build_glass()] + PR.fairy_lights(),
    "Portholes": lambda: porthole("Porthole_Port", *L.PORTHOLE_PORT, -1) + porthole("Porthole_Stbd", *L.PORTHOLE_STBD, 1),
    "Console": lambda: build_console() + PR.gauges(),
    "Seat": PR.seat,
    "Desk": lambda: PR.radio() + PR.desk_lamp() + PR.orrery() + PR.desk_things(),
    "Deck": PR.deck_things,
    "Nook": PR.nook,
    "Galley": PR.galley,
    "Back": PR.back_wall,
    "Ceiling": lambda: PR.pendant() + PR.hanging_plant(),
}


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--glb")
    ap.add_argument("--report")
    a = ap.parse_args(argv)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    report = {"parts": {}}
    bad = []
    seen = {}
    for area, fn in AREAS.items():
        coll = bpy.data.collections.new(area)
        bpy.context.scene.collection.children.link(coll)
        for P in fn():
            if P.name in seen:
                bad.append(f"{P.name}: duplicate part name (from {seen[P.name]} and {area})")
            seen[P.name] = area
            if P.open_edges():
                bad.append(f"{P.name}: {P.open_edges()} open edges before Blender")
            ob = to_object(P, coll)
            st = mesh_stats(ob)
            report["parts"][ob.name] = st
            if st["open_edges"] or st["volume"] <= 0 or st["zero_area"]:
                bad.append(f"{ob.name}: {st}")
    report["total_tris"] = sum(p["tris"] for p in report["parts"].values())
    for k, v in report["parts"].items():
        print(f"PART {k:26s} {v}")
    print(f"TOTAL tris {report['total_tris']:,}  parts {len(report['parts'])}")
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=os.path.abspath(a.out))
    if a.report:
        json.dump(report, open(a.report, "w"), indent=1)
    if a.glb:
        export_blockout(a.glb)
    if bad:
        raise RuntimeError("build checks failed:\n  " + "\n  ".join(bad))
    print("BUILD OK", a.out)


CLAY = {"glass": (0.6, 0.75, 0.85, 0.15), "emit_warm": (1.0, 0.8, 0.5, 1), "emit_strip": (1.0, 0.7, 0.4, 1),
        "emit_screen": (0.9, 0.6, 0.3, 1), "screen": (0.1, 0.1, 0.1, 1), "walnut": (0.32, 0.2, 0.13, 1),
        "bronze": (0.42, 0.3, 0.2, 1), "brass": (0.75, 0.6, 0.35, 1), "fabric_teal": (0.12, 0.3, 0.32, 1),
        "fabric_mustard": (0.7, 0.5, 0.15, 1), "fabric_rust": (0.55, 0.22, 0.12, 1), "fabric_cream": (0.8, 0.75, 0.65, 1),
        "wall_wood": (0.55, 0.42, 0.3, 1), "ceiling_wood": (0.7, 0.6, 0.48, 1), "floor_wood": (0.35, 0.24, 0.16, 1),
        "plant": (0.2, 0.42, 0.18, 1), "terracotta": (0.62, 0.35, 0.22, 1), "rug": (0.6, 0.35, 0.25, 1),
        "shade_fabric": (0.85, 0.75, 0.6, 1), "ceramic": (0.8, 0.78, 0.72, 1), "ceramic_dark": (0.15, 0.25, 0.3, 1),
        "metal_dark": (0.18, 0.17, 0.16, 1), "lining_dark": (0.12, 0.1, 0.08, 1), "rubber": (0.05, 0.05, 0.05, 1)}


def export_blockout(path):
    """flat-coloured GLB for framing checks in the browser: one material per zone (Principled, base colour only)"""
    mats = {}
    for z in ZONES:
        m = bpy.data.materials.new("Z_" + z)
        col = CLAY.get(z, (0.6, 0.6, 0.6, 1))
        bsdf = m.node_tree.nodes.get("Principled BSDF")
        bsdf.inputs["Base Color"].default_value = col
        bsdf.inputs["Roughness"].default_value = 0.6
        if z.startswith("emit"):
            bsdf.inputs["Emission Color"].default_value = col
            bsdf.inputs["Emission Strength"].default_value = 4.0
        if z == "glass":
            bsdf.inputs["Alpha"].default_value = 0.15
            m.surface_render_method = "BLENDED"
        if z in ("brass", "bronze"):
            bsdf.inputs["Metallic"].default_value = 1.0
            bsdf.inputs["Roughness"].default_value = 0.35
        m.use_backface_culling = True
        mats[z] = m
    for ob in bpy.data.objects:
        if ob.type != "MESH":
            continue
        me = ob.data
        zones = np.zeros(len(me.polygons), np.int32)
        me.attributes["zone"].data.foreach_get("value", zones)
        used = sorted(set(zones.tolist()))
        for z in used:
            me.materials.append(mats[ZONES[z]])
        idx = np.array([used.index(z) for z in zones], np.int32)
        me.polygons.foreach_set("material_index", idx)
    bpy.ops.export_scene.gltf(filepath=os.path.abspath(path), export_format="GLB", use_selection=False,
                              export_apply=True, export_attributes=False, export_extras=True)
    print("GLB", path)


main()
