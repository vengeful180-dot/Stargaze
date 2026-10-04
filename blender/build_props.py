"""build_props.py - the cabin's furniture and the things that make it lived-in (imported by build_cabin.py).

Real dimensions (a mug is 82 x 96 mm, a desk lamp shade 270 mm across ...). Every part is a closed solid; parts that
rest on something sink SINK into it, parts that hang from something start inside it (skill rule 4), fittings run
WALL_EMBED into the 5 cm lining. Built-ins against the curved hull FOLLOW it (wall_carcass) instead of poking through.
Props face the pilot: built with their front toward local -Y, then turned to their bearing on the console.
Parts the game moves carry meta["pivot"] (a world frame): build_cabin puts the object origin there, so the game turns
them about a local axis (orrery arms and radio knobs about local +Z = three.js +Y, levers about local +X).
"""
import math

import numpy as np

import cabin_layout as L
import meshkit as K

DEG = math.pi / 180.0
SINK = 0.002          # resting parts sink this far into what holds them
WALL_EMBED = 0.02     # carcasses and fittings run this far into the 5 cm lining
HANG_EMBED = 0.003    # wall-hung boards and frames


def desk_frame(phi, r, z=None):
    """frame on the console desk at bearing phi (0 = forward), radius r; local -Y faces the pilot"""
    p = (r * math.sin(phi), r * math.cos(phi), L.DESK_Z if z is None else z)
    return K.translate(p) @ K.rot_z(-phi)


def deck_frame(phi, r):
    return desk_frame(phi, r, L.DECK_Z)


def tube(P, path, r, zone, n=8, caps=True, group="", scale=None):
    K.sweep(P, np.asarray(path, np.float64), K.circle_section(r, n), caps=caps, zone_fn=lambda j: zone, group=group,
            scale=scale)


def sphere(P, c, r, zone, n=16, group=""):
    prof = [(0.0, -r)] + [(r * math.sin(a), -r * math.cos(a)) for a in np.linspace(0, math.pi, n // 2 + 1)[1:-1]] + [(0.0, r)]
    K.lathe(P, prof, K.translate(c), n, lambda k: zone, group=group)


def pivot(P, M):
    P.meta["pivot"] = np.asarray(M, np.float64)
    return P


def wall_x(z, side):
    """inner face of the cylinder wall at height z (side +1 starboard, -1 port)"""
    return side * L.wall_x_at_z(z)


def wall_carcass(name, side, y0, y1, x_front, z0, z1, zone, r_edge=0.006, n_mid=10):
    """a built-in (bench, cabinet) from x_front back into the curved wall: every ring follows the wall at its own
    height and runs WALL_EMBED into the lining; the exposed front and top edges are eased with radius r_edge"""
    P = K.Part(name, zone)

    def outline(inset, z):
        xw = wall_x(z, side) + side * WALL_EMBED
        a, b = (x_front, xw) if side > 0 else (xw, x_front)
        w, d = (b - a) - 2 * inset, (y1 - y0) - 2 * inset
        o = K.rounded_rect(w, d, max(1e-4, r_edge - inset), 3)
        o[:, 0] += (a + b) / 2
        o[:, 1] += (y0 + y1) / 2
        return o

    K.outline_slab(P, outline, K.round_profile(z1 - z0, r_edge, 3, True, z0, n_mid), zone_fn=lambda k: zone)
    return P


def hardcover(name, M, w, d, t, zone="book", open_gap=0.0):
    """a closed hardcover lying flat, spine along local -x: two boards, a spine, a page block showing on three sides
    (the boards overhang the pages by 3 mm). Base at local z = 0."""
    P = K.Part(name, zone)
    bt = 0.0028                                            # board thickness
    K.rbox(P, (w, d, bt), 0.0012, M, 2, zone)
    K.rbox(P, (w, d, bt), 0.0012, M @ K.translate((0, 0, t - bt)), 2, zone)
    K.rbox(P, (0.006, d, t), 0.0025, M @ K.translate((-w / 2 + 0.003, 0, 0)), 2, zone)
    K.box(P, (w - 0.006, d - 0.006, t - 2 * bt + 0.0008), M @ K.translate((-0.0015, 0, bt - 0.0004)), "paper")
    return P


# ============================================================================================== radio
RADIO_PHI, RADIO_R = 64 * DEG, 0.8


def radio():
    parts = []
    M = desk_frame(RADIO_PHI, RADIO_R)
    W, D, H = 0.34, 0.17, 0.21
    lift = 0.009                                              # the body stands on rubber feet
    body = K.Part("Radio_Body", "walnut")
    K.rbox(body, (W, D, H), 0.03, M @ K.translate((0, 0, lift)), 4, "walnut")
    parts.append(body)
    feet = K.Part("Radio_Feet", "rubber")
    for sx in (-1, 1):
        for sy in (-1, 1):
            K.lathe(feet, [(0.0, -SINK), (0.012, -SINK), (0.012, lift + 0.003), (0.0, lift + 0.003)],
                    M @ K.translate((sx * (W / 2 - 0.035), sy * (D / 2 - 0.03), 0.0)), 16, lambda k: "rubber")
    parts.append(feet)
    # speaker: dark cloth set into the front, a brass frame round it and horizontal brass bars over it
    gx, gw, gh, gz = -0.07, 0.15, 0.13, 0.115
    front = M @ K.translate((gx, -D / 2, gz + lift)) @ K.rot_x(math.pi / 2)     # local z points out of the front
    cloth = K.Part("Radio_Cloth", "lining_dark")
    K.box(cloth, (gw + 0.004, gh + 0.004, 0.012), front @ K.translate((0, 0, -0.008)), "lining_dark")
    parts.append(cloth)
    grille = K.Part("Radio_Grille", "brass")
    K.frame_ring(grille, (gw + 0.018, gh + 0.018), (gw, gh), 0.012, 0.006, -0.003, 0.010, front, "brass")
    for k in range(9):
        yy = -gh / 2 + 0.012 + k * (gh - 0.024) / 8
        K.rbox(grille, (gw + 0.008, 0.005, 0.006), 0.002, front @ K.translate((0, yy, 0.003)), 2, "brass")
    parts.append(grille)
    # tuning window: an emissive scale recessed behind a brass bezel, two knobs under it
    dx, dz = 0.08, 0.15
    Mf = M @ K.translate((dx, -D / 2, dz + lift)) @ K.rot_x(math.pi / 2)
    dial = K.Part("Radio_Dial", "emit_screen")
    K.box(dial, (0.094, 0.04, 0.006), Mf @ K.translate((0, 0, -0.003)), "emit_screen", "B")
    parts.append(dial)
    bez = K.Part("Radio_DialBezel", "brass")
    K.frame_ring(bez, (0.11, 0.058), (0.096, 0.042), 0.01, 0.005, -0.003, 0.006, Mf, "brass")
    parts.append(bez)
    for kx, name in ((dx - 0.03, "Radio_Knob_Volume"), (dx + 0.03, "Radio_Knob_Tune")):
        kn = K.Part(name, "brass")
        Mk = M @ K.translate((kx, -D / 2, 0.075 + lift)) @ K.rot_x(math.pi / 2)
        prof = [(0.0, -0.008), (0.016, -0.008), (0.018, 0.003), (0.0175, 0.015), (0.0145, 0.02), (0.0, 0.021)]
        K.lathe(kn, prof, Mk, 28, lambda q: "brass")
        # a pointer ridge so turning reads
        K.box(kn, (0.003, 0.014, 0.004), Mk @ K.translate((0, 0.007, 0.0185)), "walnut")
        parts.append(pivot(kn, Mk))
    # leather carrying strap with its ends screwed into the top, and a telescopic aerial at the back
    strap = K.Part("Radio_Strap", "leather")
    top = H + lift
    path = K.bezier((-0.12, 0, top - 0.005), (-0.13, 0, top + 0.055), (0.13, 0, top + 0.055), (0.12, 0, top - 0.005), 22)
    K.sweep(strap, K.apply(M, path), K.rounded_rect(0.024, 0.005, 0.002, 2), up=K.apply(M, [(0, 1, 0)])[0] - K.apply(M, [(0, 0, 0)])[0],
            zone_fn=lambda j: "leather")
    for sx in (-1, 1):
        K.lathe(strap, [(0.0, top - 0.004), (0.009, top - 0.004), (0.009, top + 0.006), (0.0, top + 0.008)],
                M @ K.translate((sx * 0.12, 0, 0)), 16, lambda k: "brass")
    parts.append(strap)
    aer = K.Part("Radio_Aerial", "brass")
    base = np.array([0.13, D / 2 - 0.025, top - 0.006])
    tip = base + np.array([0.05, 0.09, 0.22])
    K.lathe(aer, [(0.0, top - 0.006), (0.008, top - 0.006), (0.008, top + 0.01), (0.0, top + 0.012)],
            M @ K.translate((base[0], base[1], 0)), 16, lambda k: "brass")
    seg = np.linspace(base + np.array([0, 0, 0.008]), tip, 12)
    tube(aer, K.apply(M, seg), 0.0024, "brass", 8, scale=lambda i: 1.0 - 0.45 * i / 11)
    sphere(aer, K.apply(M, [tip])[0], 0.004, "brass", 10)
    parts.append(aer)
    return parts


# ============================================================================================== desk lamp
def desk_lamp():
    parts = []
    M = desk_frame(-62 * DEG, 0.82)
    base = K.Part("Lamp_Desk", "walnut")
    K.lathe(base, [(0.0, -SINK), (0.082, -SINK), (0.085, 0.006), (0.083, 0.02), (0.076, 0.026), (0.0, 0.026)], M, 40,
            lambda k: "walnut")
    # brass stem with a collar, rising from inside the base, ending in the bulb socket
    K.lathe(base, [(0.0, 0.015), (0.022, 0.015), (0.022, 0.034), (0.009, 0.04), (0.008, 0.31), (0.0, 0.31)], M, 24,
            lambda k: "brass")
    # the socket is slim and sits low under the bulb: a 21 mm socket 25 mm under the filament shadowed a 40 deg cone
    # and left the desk round the base dark (no pool of light)
    K.lathe(base, [(0.0, 0.302), (0.0125, 0.302), (0.0125, 0.312), (0.019, 0.314), (0.019, 0.322), (0.0125, 0.324),
                   (0.0125, 0.346), (0.0, 0.346)], M, 24, lambda k: "brass")
    parts.append(base)
    shade = K.Part("Lamp_DeskShade", "shade_fabric")
    z0, z1, r0, r1, t = 0.255, 0.425, 0.135, 0.075, 0.003
    K.lathe(shade, [(r0, z0), (r1, z1), (r1 - t, z1), (r0 - t, z0)], M, 48, lambda k: "shade_fabric")
    parts.append(shade)
    # three spokes from the socket's ring to the shade wall, under the bulb (an "uno" fitter)
    harp = K.Part("Lamp_Harp", "brass")
    zs = 0.3
    rw = r0 + (r1 - r0) * (zs - z0) / (z1 - z0) - t / 2
    for a in (0.5, 0.5 + 2 * math.pi / 3, 0.5 + 4 * math.pi / 3):
        p0 = np.array([0.011 * math.cos(a), 0.011 * math.sin(a), 0.318])
        p1 = np.array([rw * math.cos(a), rw * math.sin(a), zs])
        tube(harp, K.apply(M, np.linspace(p0, p1, 6)), 0.0018, "brass", 6)
    parts.append(harp)
    bulb = K.Part("Light_DeskLampBulb", "emit_warm")
    sphere(bulb, K.apply(M, [(0, 0, 0.371)])[0], 0.028, "emit_warm", 16, "A")
    parts.append(bulb)
    return parts


# ============================================================================================== orrery
ORRERY_PHI, ORRERY_R = -27 * DEG, 0.79
ORRERY_PLANE = 0.192            # planets sit in one plane above the desk; arms are tiered (outer arms lowest)
ORRERY_ARMS = [                 # (arm radius, arm height, planet radius, zone)
    (0.034, 0.167, 0.006, "brass"),
    (0.065, 0.139, 0.008, "enamel_cream"),
    (0.096, 0.111, 0.008, "ceramic_dark"),
    (0.127, 0.083, 0.007, "enamel_red"),
    (0.158, 0.055, 0.013, "terracotta"),
]


def orrery():
    parts = []
    M = desk_frame(ORRERY_PHI, ORRERY_R)
    base = K.Part("Orrery_Base", "walnut")
    K.lathe(base, [(0.0, -SINK), (0.092, -SINK), (0.095, 0.012), (0.088, 0.03), (0.0, 0.03)], M, 48, lambda k: "walnut")

    def col_r(z):
        return 0.012 + (0.007 - 0.012) * (z - 0.04) / 0.17

    K.lathe(base, [(0.0, 0.026), (0.07, 0.026), (0.07, 0.034), (0.012, 0.04), (col_r(0.21), 0.21), (0.0, 0.21)], M, 32,
            lambda k: "brass")
    parts.append(base)
    sun = K.Part("Light_OrrerySun", "emit_orrery")
    sphere(sun, K.apply(M, [(0, 0, 0.222)])[0], 0.02, "emit_orrery", 20, "B")
    parts.append(sun)
    # each arm: a collar on the column, a bar out, a rod up to the planet plane; tiered so no arm can hit another.
    # Arms rest spread round (rest angle in the node's extras); the game turns each to its real planet.
    for k, (r, zarm, pr, col) in enumerate(ORRERY_ARMS):
        rest = math.radians(18 + 72 * k + 31 * (k % 2))
        M = desk_frame(ORRERY_PHI, ORRERY_R) @ K.rot_z(rest)
        arm = K.Part(f"Orrery_Arm_{k + 1}", "brass")
        arm.meta["rest_angle"] = rest
        hub = col_r(zarm) + 0.003
        K.lathe(arm, [(0.0, zarm - 0.005), (hub, zarm - 0.005), (hub, zarm + 0.005), (0.0, zarm + 0.005)], M, 20,
                lambda q: "brass")
        top = ORRERY_PLANE - pr + 0.003
        pts = [(hub - 0.002, 0, zarm), (r, 0, zarm), (r, 0, top)]
        path = np.vstack([np.linspace(pts[0], pts[1], 6), np.linspace(pts[1], pts[2], 6)[1:]])
        tube(arm, K.apply(M, path), 0.0016, "brass", 6)
        sphere(arm, K.apply(M, [(r, 0, ORRERY_PLANE)])[0], pr, col, 16)
        if k == len(ORRERY_ARMS) - 1:
            # the ringed giant: a thin brass disc through its equator, tilted across the arm
            Mr = M @ K.translate((r, 0, ORRERY_PLANE)) @ K.rot_y(35 * DEG)
            K.lathe(arm, [(pr * 0.8, -0.0006), (pr * 1.75, -0.0006), (pr * 1.75, 0.0006), (pr * 0.8, 0.0006)], Mr, 32,
                    lambda q: "brass")
        parts.append(pivot(arm, M))
    return parts


# ============================================================================================== mug, logbook, pad
def mug(name, M, tea=True, glaze="ceramic"):
    parts = []
    P = K.Part(name, glaze)
    prof = [(0.0, 0.003), (0.034, 0.003), (0.036, -SINK), (0.0395, 0.004), (0.041, 0.012), (0.041, 0.09),
            (0.0395, 0.0955), (0.037, 0.0955), (0.0365, 0.093), (0.0365, 0.014), (0.03, 0.011), (0.0, 0.011)]
    K.lathe(P, prof, M, 40, lambda k: glaze)
    # handle: a flattened tube on a curve, both roots 3 mm into the wall
    path = K.bezier((0.038, 0, 0.078), (0.08, 0, 0.082), (0.082, 0, 0.024), (0.038, 0, 0.028), 18)
    K.sweep(P, K.apply(M, path), K.rounded_rect(0.012, 0.008, 0.0035, 2), up=K.apply(M, [(0, 1, 0)])[0] - K.apply(M, [(0, 0, 0)])[0],
            zone_fn=lambda j: glaze)
    parts.append(P)
    if tea:
        T = K.Part(name + "_Tea", "tea")
        K.lathe(T, [(0.0, 0.07), (0.0372, 0.07), (0.0372, 0.074), (0.0, 0.074)], M, 32, lambda k: "tea")
        parts.append(T)
    return parts


def hanging_mug_frame(hook, a, hook_r=0.0045):
    """frame of a mug hung by its handle on a hook pointing along bearing a (radially out of a mug tree): the loop's
    plane is perpendicular to the hook, the handle's inner top rests on the hook (1 mm in), and the mug tilts about
    the hook until its centre of mass hangs straight under the contact"""
    contact = np.array([0.055, 0.0, 0.072])                  # handle's inner top, mug coordinates (see mug())
    com = np.array([0.0, 0.0, 0.045])
    v = com - contact
    beta = math.atan2(-v[0], v[2])                           # rot_y(beta) @ v points straight down
    if (-math.sin(beta) * v[0] + math.cos(beta) * v[2]) > 0:
        beta += math.pi
    B = K.frame((0, 0, 0), (math.sin(a), -math.cos(a), 0.0), (math.cos(a), math.sin(a), 0.0))
    R = B @ K.rot_y(beta)
    T = np.asarray(hook) + np.array([0, 0, hook_r - 0.001]) - R[:3, :3] @ contact
    return K.translate(T) @ R


def desk_things():
    parts = []
    parts += mug("Mug", desk_frame(25 * DEG, 0.74) @ K.rot_z(-0.9))
    pad = K.Part("Console_Pad", "leather")
    K.rbox(pad, (0.5, 0.26, 0.005), 0.002, desk_frame(0.0, 0.74) @ K.translate((0, 0, -SINK)), 2, "leather")
    parts.append(pad)
    pad_top = 0.005 - SINK
    Mb = desk_frame(-6 * DEG, 0.73) @ K.rot_z(0.12) @ K.translate((0, 0, pad_top - 0.001))
    parts.append(hardcover("Logbook", Mb, 0.15, 0.21, 0.022, "leather"))
    pencil = K.Part("Pencil", "enamel_red")
    r = 0.0038
    Mp = Mb @ K.translate((0.1, 0.0, 0.001 + r - 0.0008)) @ K.rot_z(0.08)
    tube(pencil, K.apply(Mp, np.linspace((0, -0.075, 0), (0, 0.07, 0), 4)), r, "enamel_red", 6)
    K.lathe(pencil, [(0.0, -0.002), (r * 0.98, -0.002), (0.0012, 0.019), (0.0, 0.022)], Mp @ K.translate((0, 0.07, 0)) @ K.rot_x(-math.pi / 2),
            12, lambda k: "paper")
    parts.append(pencil)
    # throttle quadrant on the right of the desk: the lever pivots at its foot about local x
    Mt = desk_frame(40 * DEG, 0.86)
    th = K.Part("Throttle_Base", "metal_dark")
    K.rbox(th, (0.07, 0.15, 0.045), 0.012, Mt @ K.translate((0, 0, -SINK)), 3, "metal_dark")
    K.box(th, (0.012, 0.11, 0.004), Mt @ K.translate((0, 0, 0.041)), "rubber")
    parts.append(th)
    lever = K.Part("Throttle_Lever", "brass")
    path = [(0, 0.02, 0.03), (0, 0.0, 0.09), (0, -0.03, 0.14)]
    path = np.vstack([np.linspace(path[0], path[1], 5), np.linspace(path[1], path[2], 5)[1:]])
    tube(lever, K.apply(Mt, path), 0.006, "brass", 10)
    sphere(lever, K.apply(Mt, [(0, -0.033, 0.152)])[0], 0.017, "walnut", 18)
    parts.append(pivot(lever, Mt @ K.translate((0, 0.02, 0.03))))
    # toggle switches on a brass plate, left of the knee well; each toggle pivots about local x
    Ms = desk_frame(-44 * DEG, 0.9)
    plate = K.Part("Switch_Plate", "brass")
    K.rbox(plate, (0.17, 0.07, 0.006), 0.004, Ms @ K.translate((0, 0, -SINK)), 2, "brass")
    for k in range(4):
        x = -0.06 + 0.04 * k
        K.lathe(plate, [(0.0, 0.002), (0.009, 0.002), (0.009, 0.012), (0.0, 0.012)], Ms @ K.translate((x, 0.005, 0)), 16,
                lambda q: "metal_dark")
    parts.append(plate)
    for k in range(4):
        x = -0.06 + 0.04 * k
        sw = K.Part(f"Switch_{k + 1}", "brass")
        tube(sw, K.apply(Ms, np.linspace((x, 0.005, 0.008), (x, -0.012, 0.036), 4)), 0.0028, "brass", 8)
        sphere(sw, K.apply(Ms, [(x, -0.0125, 0.037)])[0], 0.0042, "brass", 10)
        parts.append(pivot(sw, Ms @ K.translate((x, 0.005, 0.01))))
    return parts


# ============================================================================================== binnacle gauges
def gauges():
    parts = []
    h = L.BINNACLE_TOP - (L.DESK_Z - 0.01)
    lean = math.tan(L.BINNACLE_LEAN)
    for k, phi in enumerate((-15.5 * DEG, 15.5 * DEG)):
        u = 0.55
        r = L.DESK_R1 - 0.02 + lean * h * u
        p = np.array([r * math.sin(phi), r * math.cos(phi), L.DESK_Z - 0.01 + h * u])
        n = np.array([-math.sin(phi), -math.cos(phi), lean])
        n /= np.linalg.norm(n)
        xax = np.array([math.cos(phi), -math.sin(phi), 0.0])
        M = K.frame(p, xax, np.cross(n, xax))
        M[:3, 2] = n
        g = K.Part(f"Gauge_{k + 1}", "brass")
        K.lathe(g, [(0.0, -0.008), (0.042, -0.008), (0.044, 0.004), (0.04, 0.01), (0.034, 0.008), (0.034, 0.002),
                    (0.0, 0.002)], M, 40, lambda q: "brass")
        parts.append(g)
        face = K.Part(f"Gauge_{k + 1}_Face", "gauge_face")
        K.lathe(face, [(0.0, 0.0015), (0.0336, 0.0015), (0.0336, 0.0045), (0.0, 0.0045)], M, 40, lambda q: "gauge_face")
        parts.append(pivot(face, M))
        needle = K.Part(f"Gauge_{k + 1}_Needle", "enamel_red")
        K.box(needle, (0.003, 0.028, 0.0015), M @ K.translate((0, 0.0, 0.0042)) @ K.rot_z(0.6 - 1.2 * k) @ K.translate((0, 0.01, 0)),
              "enamel_red")
        sphere(needle, K.apply(M, [(0, 0, 0.0052)])[0], 0.004, "brass", 10)
        parts.append(pivot(needle, M))
    return parts


# ============================================================================================== plants
def heart_leaf(P, M, size, zone, n=10, thick=0.0012, curl=0.18):
    """a closed heart-shaped leaf (pothos), base at local origin, tip along +y, domed along its midrib"""
    t = np.linspace(0, math.pi, n)
    xs = size * 0.62 * np.sin(t) ** 1.1 * (1 + 0.25 * np.cos(t))
    ys = size * (0.5 - 0.5 * np.cos(t)) * 1.05 - size * 0.08 * np.sin(t) ** 6
    right = np.column_stack([xs, ys])
    left = np.column_stack([-xs[::-1], ys[::-1]])[1:-1]
    outline = np.vstack([right, left])
    m = len(outline)
    z = curl * size * (1 - (outline[:, 0] / (size * 0.62)) ** 2) * np.sin(np.clip(outline[:, 1] / size, 0, 1) * math.pi) * 0.5
    top = P.vs(np.column_stack([outline, z + thick / 2]), M)
    bot = P.vs(np.column_stack([outline, z - thick / 2]), M)
    ct = P.vs([(0, size * 0.45, curl * size * 0.5 + thick / 2)], M)
    cb = P.vs([(0, size * 0.45, curl * size * 0.5 - thick / 2)], M)
    for j in range(m):
        j2 = (j + 1) % m
        P.f((ct, top + j, top + j2), zone)
        P.f((cb, bot + j2, bot + j), zone)
        P.f((top + j, bot + j, bot + j2, top + j2), zone)


def _leaves_along(P, path, rng, n_leaves, size_range, start=0.2, zone="plant", outward=None):
    """alternating heart leaves along a stem path (world coordinates), bases sunk into the stem"""
    path = np.asarray(path)
    for k in range(n_leaves):
        t = start + (1 - start) * (k + 0.5) / n_leaves
        i = min(len(path) - 2, int(t * (len(path) - 1)))
        c = path[i]
        tan = path[i + 1] - path[max(i - 1, 0)]
        tan /= np.linalg.norm(tan)
        side = np.cross(tan, [0, 0, 1])
        if np.linalg.norm(side) < 1e-6:
            side = np.array([1.0, 0, 0])
        side /= np.linalg.norm(side)
        side *= (1 if k % 2 else -1)
        leaf_dir = side * 0.75 + np.array([0, 0, 0.45]) + (outward if outward is not None else 0) * 0.25
        leaf_dir /= np.linalg.norm(leaf_dir)
        up = np.cross(leaf_dir, tan)
        if np.linalg.norm(up) < 1e-6:
            up = np.array([0, 0, 1.0])
        if np.dot(up, [0, 0, 1]) < 0:
            up = -up
        size = rng.uniform(*size_range) * (1.1 - 0.35 * t)
        Ml = K.frame(c - leaf_dir * 0.0015, np.cross(leaf_dir, up), leaf_dir)
        heart_leaf(P, Ml, size, zone, 10, 0.0012, rng.uniform(0.1, 0.25))


def pot(name, M, pot_r=0.065, pot_h=0.11):
    parts = []
    P = K.Part(name + "_Pot", "terracotta")
    K.lathe(P, [(0.0, -SINK), (pot_r * 0.78, -SINK), (pot_r, pot_h - 0.012), (pot_r + 0.006, pot_h - 0.01),
                (pot_r + 0.006, pot_h), (pot_r - 0.006, pot_h), (pot_r - 0.008, pot_h - 0.015), (0.0, pot_h - 0.015)],
            M, 32, lambda k: "terracotta")
    parts.append(P)
    soil = K.Part(name + "_Soil", "soil")
    K.lathe(soil, [(0.0, pot_h - 0.03), (pot_r - 0.004, pot_h - 0.03), (pot_r - 0.006, pot_h - 0.012), (0.0, pot_h - 0.01)],
            M, 24, lambda k: "soil")
    parts.append(soil)
    return parts


def plant_bush(name, M, rng, stems=7, height=0.14, spread=0.1, leaves=5, leaf=(0.03, 0.045), pot_r=0.065, pot_h=0.11):
    """an upright potted plant: stems rise from the soil and arch outward, every tip stays above the pot's base
    (nothing to collide with on a deck or a shelf)"""
    parts = pot(name, M, pot_r, pot_h)
    P = K.Part(name + "_Leaves", "plant")
    soil = pot_h - 0.012
    for s in range(stems):
        a = 2 * math.pi * (s + rng.uniform(-0.3, 0.3)) / stems
        out = np.array([math.cos(a), math.sin(a), 0.0])
        hgt = height * rng.uniform(0.6, 1.0)
        rad = spread * rng.uniform(0.5, 1.0)
        p0 = np.array([0.0, 0.0, soil - 0.012]) + out * 0.01
        p1 = p0 + np.array([0, 0, hgt * 0.7]) + out * rad * 0.15
        p2 = p0 + np.array([0, 0, hgt * 1.0]) + out * rad * 0.6
        p3 = p0 + np.array([0, 0, hgt * 0.75]) + out * rad
        path = K.apply(M, K.bezier(p0, p1, p2, p3, 16))
        K.sweep(P, path, K.circle_section(0.0018, 5), zone_fn=lambda j: "leaf_dark")
        _leaves_along(P, path, rng, leaves, leaf, 0.35, outward=K.apply(M, [out])[0] - K.apply(M, [(0, 0, 0)])[0])
    parts.append(P)
    return parts


def plant_trail(name, M, rng, vines=6, length=0.4, spread=0.12, leaves=7, leaf=(0.032, 0.05), pot_r=0.075, pot_h=0.12,
                dirs=None):
    """a trailing plant in a hanging pot: vines climb over the rim and fall freely (nothing below them)"""
    parts = pot(name, M, pot_r, pot_h)
    P = K.Part(name + "_Leaves", "plant")
    soil = pot_h - 0.012
    for v in range(vines):
        if dirs:
            a = dirs[0] + rng.uniform(-dirs[1], dirs[1])
        else:
            a = 2 * math.pi * (v + rng.uniform(-0.35, 0.35)) / vines
        out = np.array([math.cos(a), math.sin(a), 0.0])
        ln = length * rng.uniform(0.55, 1.15)
        p0 = np.array([0.0, 0.0, soil - 0.012]) + out * 0.015
        p1 = out * (pot_r + 0.01) + np.array([0, 0, pot_h + 0.04])
        p2 = out * (pot_r + spread * 0.6) + np.array([0, 0, pot_h - 0.02])
        p3 = out * (pot_r + spread) + np.array([0, 0, pot_h - ln])
        path = K.apply(M, np.vstack([K.bezier(p0, p0 + (0, 0, 0.03), p1 - out * 0.02, p1, 8),
                                     K.bezier(p1, p1 + out * 0.03, p2, p3, 22)[1:]]))
        K.sweep(P, path, K.circle_section(0.002, 5), zone_fn=lambda j: "leaf_dark")
        _leaves_along(P, path, rng, leaves, leaf, 0.25, outward=K.apply(M, [out])[0] - K.apply(M, [(0, 0, 0)])[0])
    parts.append(P)
    return parts


# ============================================================================================== window deck
TELESCOPE = (-64 * DEG, 1.17)
FAIRY_BOX = (60 * DEG, 1.2)


def deck_things():
    rng = np.random.default_rng(7)
    parts = []
    parts += plant_bush("Plant_DeckL", deck_frame(-46 * DEG, 1.19), rng, 8, 0.15, 0.11, 5)
    parts += plant_bush("Plant_DeckR", deck_frame(46 * DEG, 1.19), rng, 7, 0.13, 0.1, 5)
    # telescope: a brass refractor on a small walnut tripod, aimed forward and up through the glass
    phi, r = TELESCOPE
    Mt = deck_frame(phi, r)
    tri = K.Part("Telescope_Mount", "walnut")
    head = np.array([0, 0, 0.16])
    for a in (0.3, 0.3 + 2 * math.pi / 3, 0.3 + 4 * math.pi / 3):
        foot = np.array([0.07 * math.cos(a), 0.07 * math.sin(a), -SINK])
        tube(tri, K.apply(Mt, np.linspace(foot, head, 6)), 0.005, "walnut", 8)
    K.lathe(tri, [(0.0, 0.148), (0.016, 0.148), (0.016, 0.175), (0.0, 0.175)], Mt, 16, lambda k: "brass")
    parts.append(tri)
    tel = K.Part("Telescope", "brass")
    pv = K.apply(Mt, [(0, 0, 0.19)])[0]
    az, el = -18 * DEG, 34 * DEG
    d = np.array([math.cos(el) * math.sin(az), math.cos(el) * math.cos(az), math.sin(el)])
    xa = np.cross([0, 0, 1.0], d)
    xa /= np.linalg.norm(xa)
    Mtube = K.frame(pv, xa, np.cross(d, xa))
    K.lathe(tel, [(0.0, -0.13), (0.011, -0.13), (0.011, -0.095), (0.015, -0.088), (0.015, 0.0), (0.02, 0.016),
                  (0.02, 0.16), (0.024, 0.168), (0.024, 0.19), (0.0, 0.19)], Mtube, 28, lambda k: "brass")
    K.rbox(tel, (0.03, 0.03, 0.035), 0.006, Mt @ K.translate((0, 0, 0.166)), 2, "brass")
    parts.append(tel)
    # two books lying on the starboard deck
    for k in range(2):
        Mb = deck_frame(74 * DEG, 1.19) @ K.rot_z(0.25 + 0.3 * k) @ K.translate((0, 0, -SINK + 0.0255 * k))
        parts.append(hardcover(f"Deck_Book_{k + 1}", Mb, 0.15 - 0.01 * k, 0.22 - 0.015 * k, 0.026))
    # a jar of tiny lights: warm LEDs on a wire coiled inside a glass jar
    Mj = deck_frame(-24 * DEG, 1.15)
    jar = K.Part("StarJar_Glass", "glass")
    K.lathe(jar, [(0.0, -SINK), (0.042, -SINK), (0.045, 0.01), (0.045, 0.12), (0.032, 0.135), (0.032, 0.15), (0.0, 0.15)],
            Mj, 28, lambda k: "glass")
    parts.append(jar)
    lid = K.Part("StarJar_Lid", "brass")
    K.lathe(lid, [(0.0, 0.145), (0.035, 0.145), (0.035, 0.162), (0.0, 0.162)], Mj, 24, lambda k: "brass")
    parts.append(lid)
    coil = []
    for k in range(80):
        t = k / 79
        a = t * 2 * math.pi * 4.2
        rr = 0.03 * (0.55 + 0.45 * math.sin(t * 9.0 + 1.0) ** 2)
        coil.append((rr * math.cos(a), rr * math.sin(a), 0.006 + 0.11 * t))
    coil = K.apply(Mj, coil)
    wire = K.Part("StarJar_Wire", "wire")
    tube(wire, coil, 0.0008, "wire", 5)
    parts.append(wire)
    leds = K.Part("Light_StarJar", "emit_warm")
    for k in range(4, 80, 4):
        sphere(leds, coil[k], 0.0032, "emit_warm", 8, "A")
    parts.append(leds)
    return parts


# ============================================================================================== seat
SEAT_BACK_LEAN = 14 * DEG


def seat():
    parts = []
    sx, sy = L.SEAT_AXIS
    M = K.translate((sx, sy, 0.0))
    base = K.Part("Seat_Pedestal", "metal_dark")
    K.lathe(base, [(0.0, -0.01), (0.27, -0.01), (0.27, 0.018), (0.2, 0.03), (0.055, 0.06), (0.045, 0.32), (0.0, 0.32)],
            M, 48, lambda k: "metal_dark")
    parts.append(base)
    tray = K.Part("Seat_Tray", "walnut")
    K.rbox(tray, (0.6, 0.56, 0.05), 0.015, M @ K.translate((0, 0.0, 0.3)), 3, "walnut")
    parts.append(tray)
    cush = K.Part("Seat_Cushion", "fabric_teal")
    K.rbox(cush, (0.54, 0.52, 0.13), 0.05, M @ K.translate((0, 0.01, 0.345)), 5, "fabric_teal")
    parts.append(cush)
    # low back that leans back: a walnut shell bolted to the tray's rear edge, the cushion on its face. The head
    # clears it when you turn round to look into the cabin.
    Mb = M @ K.translate((0, -0.27, 0.31)) @ K.rot_x(SEAT_BACK_LEAN)
    shell = K.Part("Seat_Shell", "walnut")
    K.rbox(shell, (0.6, 0.05, 0.68), 0.022, Mb @ K.translate((0, -0.025, 0.0)), 3, "walnut")
    parts.append(shell)
    back = K.Part("Seat_Back", "fabric_teal")
    K.rbox(back, (0.52, 0.11, 0.5), 0.05, Mb @ K.translate((0, 0.05, 0.13)), 5, "fabric_teal")
    parts.append(back)
    for side in (1, -1):
        tag = "R" if side > 0 else "L"
        side_p = K.Part(f"Seat_Side_{tag}", "fabric_teal")
        K.rbox(side_p, (0.07, 0.5, 0.26), 0.03, M @ K.translate((side * 0.29, -0.01, 0.33)), 4, "fabric_teal")
        parts.append(side_p)
        arm = K.Part(f"Seat_Arm_{tag}", "walnut")
        K.rbox(arm, (0.1, 0.52, 0.04), 0.018, M @ K.translate((side * 0.295, 0.0, 0.585)), 3, "walnut")
        parts.append(arm)
    parts.append(seat_blanket())
    return parts


def seat_blanket():
    """a knitted blanket thrown over the left arm: it lies on the cushion, climbs the side, wraps the arm's rounded
    top and hangs free from the arm's outer edge (the side panel is inset under the arm)"""
    sx, sy = L.SEAT_AXIS
    off = 0.004                                              # centreline off the surfaces it lies on (half of 9 mm, 1 mm sunk)
    cush_top, arm_in, arm_out, arm_top, arm_bot, side_in, rr = 0.475, -0.245, -0.345, 0.625, 0.585, -0.255, 0.018
    pts = [(-0.08, cush_top + off), (-0.225, cush_top + off)]
    c = (side_in + off + 0.02, cush_top + off + 0.02)        # fillet across the cushion / side panel corner
    pts += [(c[0] + 0.02 * math.cos(a), c[1] + 0.02 * math.sin(a)) for a in np.linspace(-math.pi / 2, -math.pi, 5)[1:]]
    pts += [(side_in + off, arm_bot - 0.008), (arm_in + off, arm_bot - 0.002)]
    c = (arm_in - rr, arm_top - rr)                          # round the arm's inner top corner
    pts += [(c[0] + (rr + off) * math.cos(a), c[1] + (rr + off) * math.sin(a)) for a in np.linspace(0, math.pi / 2, 6)]
    c = (arm_out + rr, arm_top - rr)                         # and its outer top corner
    pts += [(c[0] + (rr + off) * math.cos(a), c[1] + (rr + off) * math.sin(a)) for a in np.linspace(math.pi / 2, math.pi, 6)]
    hang = [(arm_out - off - 0.002 + 0.012 * t * t, arm_top - rr - (arm_top - rr - 0.40) * t) for t in np.linspace(0.08, 1.0, 9)]
    pts += hang
    sec = np.array(pts)
    nrm = np.gradient(sec, axis=0)
    nrm = np.column_stack([-nrm[:, 1], nrm[:, 0]])
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True)
    half = 0.0045
    ys = np.linspace(-0.2, 0.14, 26)
    P = K.Part("Seat_Blanket", "knit")
    rings = []
    hang_from = len(pts) - len(hang)
    for y in ys:
        w = np.zeros(len(sec))
        for i in range(hang_from, len(sec)):
            t = (i - hang_from) / max(1, len(sec) - 1 - hang_from)
            w[i] = 0.004 * t * math.sin(2 * math.pi * (y + 0.2) / 0.085)     # folds grow toward the hem
        cl = sec + nrm * w[:, None]
        outline = np.vstack([cl + nrm * half, (cl - nrm * half)[::-1]])
        b = P.vs(np.column_stack([outline[:, 0] + sx, np.full(len(outline), y + sy), outline[:, 1]]))
        rings.append(list(range(b, b + len(outline))))
    K.grid_rings(P, rings, lambda i, j: "knit")
    K.cap_ring(P, rings[0], reverse=True, zone="knit")
    K.cap_ring(P, rings[-1], reverse=False, zone="knit")
    return P


# ============================================================================================== fairy lights
def fairy_lights():
    """a string of warm bulbs along the first canopy arch: brass clips on the rib's inner face, the wire sagging
    between them, a bulb hanging from it every third of a span; it ends in a battery box on the deck"""
    parts = []
    mu = L.ARCH_MUS[0]
    top = float(L.lam_at_z(mu, L.ZS + 0.12))
    # clips between the ribs that cross the arch (spine at 0, mullions at +-38 and +-70 deg), never on them
    lam = np.radians([-83, -76, -63, -50, -30, -17, -6, 6, 17, 30, 50, 63, 76, 83]) * (top / math.radians(83))
    ribs = [m[0] for m in L.MULLIONS]
    assert min(abs(a - r) for a in lam for r in ribs) > math.radians(5), "a fairy clip sits on a rib crossing"
    on_rib = L.ellipsoid(np.full_like(lam, mu), lam)
    nin = L.ellipsoid_normal_in(on_rib)
    clip_c = on_rib + nin * (L.RIB_IN - 0.004)              # clip centres 4 mm into the rib's inner face
    anchor = on_rib + nin * (L.RIB_IN + 0.006)               # where the wire leaves each clip
    clip = K.Part("Fairy_Clips", "brass")
    for c, n in zip(clip_c, nin):
        t = np.cross(n, [0, 1.0, 0])
        t /= np.linalg.norm(t)
        K.rbox(clip, (0.018, 0.024, 0.012), 0.003, K.frame(c, t, np.cross(n, t)) @ K.translate((0, 0, -0.003)), 2, "brass")
    wire = K.Part("Fairy_Wire", "wire")
    bulbs = K.Part("Light_Fairy", "emit_warm")
    for i in range(len(anchor) - 1):
        a, b = anchor[i], anchor[i + 1]
        path = K.catenary(a, b, 0.0, 16)
        mid_n = (nin[i] + nin[i + 1]) / 2
        s = np.sin(np.linspace(0, math.pi, 16))
        path = path + np.outer(0.03 * s, mid_n) - np.outer(0.025 * s, [0, 0, 1])
        tube(wire, np.vstack([a - nin[i] * 0.006, path, b - nin[i + 1] * 0.006]), 0.0012, "wire", 5)
        for k in (5, 10):
            drop = path[k] + np.array([0, 0, -0.012])
            tube(wire, np.linspace(path[k], drop, 3), 0.0012, "wire", 5)
            sphere(bulbs, drop + np.array([0, 0, -0.005]), 0.0072, "emit_warm", 10, "A")
    # lead from the last clip (starboard, low) down to the battery box on the deck
    phi, r = FAIRY_BOX
    Mb = deck_frame(phi, r)
    box = K.Part("Fairy_Battery", "enamel_cream")
    K.rbox(box, (0.09, 0.06, 0.032), 0.006, Mb @ K.translate((0, 0, -SINK)), 2, "enamel_cream")
    K.lathe(box, [(0.0, 0.028), (0.006, 0.028), (0.006, 0.036), (0.0, 0.037)], Mb @ K.translate((0.025, -0.012, 0)), 12,
            lambda k: "enamel_red")
    parts.append(box)
    end = anchor[-1]
    socket = K.apply(Mb, [(-0.035, 0.0, 0.026)])[0]
    lead = K.catenary(end, socket, 0.04, 20)
    tube(wire, np.vstack([end - nin[-1] * 0.006, lead]), 0.0012, "wire", 5)
    parts += [wire, bulbs, clip]
    return parts


# ============================================================================================== walls
def wall_rails(galley_y):
    """dado rail along both walls of the living area at RAIL_Z: from the back wall into the junction arch; on
    starboard it stops at the galley counter's ends (5 mm into them)"""
    parts = []
    z = L.RAIL_Z
    y0g, y1g = galley_y
    for side in (-1, 1):
        th = side * L.rail_theta()
        n = L.cylinder_normal_in(np.array(th))
        x = wall_x(z, side)
        spans = [(L.YB - 0.01, L.YJ + 0.01)] if side < 0 else [(L.YB - 0.01, y0g + 0.005), (y1g - 0.005, L.YJ + 0.01)]
        for k, (ya, yb) in enumerate(spans):
            P = K.Part(f"Trim_Dado_{'R' if side > 0 else 'L'}{k + 1 if len(spans) > 1 else ''}", "walnut")
            ys = np.linspace(ya, yb, 8)
            path = np.column_stack([np.full_like(ys, x), ys, np.full_like(ys, z)])
            frames = [(np.array([0, 1.0, 0]), n, np.cross([0, 1.0, 0], n))] * len(ys)
            sec = K.rounded_rect(0.05, 0.045, 0.01, 3)
            sec[:, 0] += 0.012
            K.sweep(P, path, sec, frames=frames, zone_fn=lambda j: "walnut")
            parts.append(P)
    return parts


# ============================================================================================== nook
def nook():
    parts = []
    y0, y1 = L.NOOK_Y
    xw = wall_x(L.NOOK_SEAT_Z, -1)
    x_in = xw + L.NOOK_DEPTH
    seat_top = L.NOOK_SEAT_Z - 0.09
    parts.append(wall_carcass("Nook_Bench", -1, y0, y1, x_in, -0.01, seat_top, "enamel_cream"))
    cush = K.Part("Nook_Cushion", "fabric_mustard")
    cx = (xw + x_in) / 2 + 0.01
    K.rbox(cush, (L.NOOK_DEPTH - 0.04, y1 - y0 - 0.04, 0.11), 0.04, K.translate((cx, (y0 + y1) / 2, seat_top - 0.01)), 4,
           "fabric_mustard")
    parts.append(cush)
    cush_top = seat_top + 0.1
    # back cushion leaning on the wall: its top back edge touches the lining (5 mm in), it stands in the seat cushion
    lean = 0.16
    hb = 0.40
    tb = 0.14
    ztop = cush_top - 0.02 + hb * math.cos(lean)
    xb = wall_x(ztop - 0.01, -1) - 0.005 + tb / 2 * math.cos(lean) + hb * math.sin(lean)
    back = K.Part("Nook_BackCushion", "fabric_mustard")
    K.rbox(back, (tb, y1 - y0 - 0.1, hb), 0.05, K.translate((xb, (y0 + y1) / 2, cush_top - 0.02)) @ K.rot_y(-lean), 4,
           "fabric_mustard")
    parts.append(back)
    for k, (yy, col) in enumerate(((y0 + 0.28, "fabric_rust"), (y1 - 0.3, "fabric_teal"))):
        pil = K.Part(f"Nook_Pillow_{k + 1}", col)
        K.rbox(pil, (0.12, 0.36, 0.34), 0.06, K.translate((xb + tb / 2 + 0.03, yy, cush_top - 0.015)) @ K.rot_y(-0.3), 4, col)
        parts.append(pil)
    blanket = K.Part("Nook_Blanket", "knit")
    K.rbox(blanket, (0.3, 0.26, 0.07), 0.025, K.translate((x_in - 0.18, y1 - 0.2, cush_top - 0.004)) @ K.rot_z(0.12), 4,
           "knit")
    parts.append(blanket)
    # an open book face-down on the cushion: two halves tented over the spine
    ob = K.Part("Nook_Book", "book")
    Mb = K.translate((xb + 0.33, (y0 + y1) / 2 - 0.05, cush_top + 0.0105)) @ K.rot_z(0.5)
    for s in (-1, 1):
        K.rbox(ob, (0.15, 0.22, 0.012), 0.002, Mb @ K.translate((s * 0.07, 0, 0)) @ K.rot_y(s * 0.18), 2, "book")
    parts.append(ob)
    parts += sconce()
    return parts


def sconce():
    """reading lamp on the wall at the front of the nook: back plate, a bent arm to a socket, a cone shade resting on
    the socket's collar, the bulb screwed in under it"""
    parts = []
    zc, yc = 1.62, -0.95
    xc = wall_x(zc, -1)
    n = L.cylinder_normal_in(np.array(-math.acos((zc - L.ZC) / L.B)))        # into the cabin
    Mw = K.frame((xc, yc, zc), (0, 1, 0), np.cross(n, (0, 1, 0)))
    Mw[:3, 2] = n
    plate = K.Part("Sconce", "brass")
    K.lathe(plate, [(0.0, -0.02), (0.045, -0.02), (0.045, 0.008), (0.03, 0.014), (0.0, 0.015)], Mw, 24, lambda k: "brass")
    sx = xc + 0.15
    path = K.bezier((xc + 0.005, yc, zc), (xc + 0.08, yc, zc + 0.01), (sx, yc, zc + 0.09), (sx, yc, zc + 0.045), 14)
    tube(plate, path, 0.005, "brass", 8)
    # socket with a collar the shade sits on
    K.lathe(plate, [(0.0, zc - 0.032), (0.013, zc - 0.032), (0.013, zc - 0.004), (0.038, zc - 0.004), (0.038, zc + 0.004),
                    (0.013, zc + 0.004), (0.013, zc + 0.05), (0.0, zc + 0.05)], K.translate((sx, yc, 0)), 24, lambda k: "brass")
    parts.append(plate)
    shade = K.Part("Sconce_Shade", "shade_fabric")
    K.lathe(shade, [(0.058, zc - 0.112), (0.036, zc + 0.0005), (0.033, zc + 0.0005), (0.055, zc - 0.112)],
            K.translate((sx, yc, 0)), 36, lambda k: "shade_fabric")
    parts.append(shade)
    bulb = K.Part("Light_SconceBulb", "emit_warm")
    K.lathe(bulb, [(0.0, zc - 0.078), (0.016, zc - 0.074), (0.023, zc - 0.058), (0.02, zc - 0.042), (0.011, zc - 0.03),
                   (0.0, zc - 0.026)], K.translate((sx, yc, 0)), 16, lambda k: "emit_warm", group="A")
    parts.append(bulb)
    return parts


# ============================================================================================== galley
def galley():
    parts = []
    y0, y1 = L.GALLEY_Y
    zt = L.GALLEY_Z
    xw = wall_x(zt, 1)
    x_in = xw - L.GALLEY_DEPTH
    rng = np.random.default_rng(5)
    parts.append(wall_carcass("Galley_Cabinet", 1, y0, y1, x_in, -0.01, zt - 0.035, "enamel_cream"))
    top = K.Part("Galley_Top", "walnut")
    xa, xb = x_in - 0.025, xw + WALL_EMBED
    K.rbox(top, (xb - xa, y1 - y0 + 0.024, 0.04), 0.008, K.translate(((xa + xb) / 2, (y0 + y1) / 2, zt - 0.04)), 3, "walnut")
    parts.append(top)
    # three doors and a row of drawers on the carcass front (facing -x), brass knobs
    Mfront = K.translate((x_in, 0, 0)) @ K.rot_y(-math.pi / 2)            # local z -> -x (out of the front)
    w3 = (y1 - y0) / 3
    for k in range(3):
        yy = y0 + (k + 0.5) * w3
        d = K.Part(f"Galley_Door_{k + 1}", "enamel_cream")
        K.rbox(d, (0.66, w3 - 0.016, 0.02), 0.004, K.translate((0, yy, 0.385)) @ Mfront @ K.translate((0, 0, -0.004)), 2,
               "enamel_cream")
        ky = yy + (w3 / 2 - 0.06) * (1 if k < 2 else -1)
        K.lathe(d, [(0.0, 0.012), (0.009, 0.012), (0.009, 0.022), (0.014, 0.03), (0.0, 0.035)],
                K.translate((0, ky, 0.64)) @ Mfront, 16, lambda q: "brass")
        parts.append(d)
        dr = K.Part(f"Galley_Drawer_{k + 1}", "enamel_cream")
        K.rbox(dr, (0.12, w3 - 0.016, 0.02), 0.004, K.translate((0, yy, 0.8)) @ Mfront @ K.translate((0, 0, -0.004)), 2,
               "enamel_cream")
        K.lathe(dr, [(0.0, 0.012), (0.008, 0.012), (0.008, 0.02), (0.012, 0.027), (0.0, 0.031)],
                K.translate((0, yy, 0.8)) @ Mfront, 16, lambda q: "brass")
        parts.append(dr)
    # shelf: shallow, because the wall leans in above it; the strip light under its front lip
    zs = L.SHELF_Z
    xs = wall_x(zs, 1)
    depth = 0.2
    shelf = K.Part("Galley_Shelf", "walnut")
    K.rbox(shelf, (depth + WALL_EMBED, y1 - y0, 0.03), 0.008, K.translate((xs - depth / 2 + WALL_EMBED / 2, (y0 + y1) / 2, zs)), 2,
           "walnut")
    parts.append(shelf)
    strip = K.Part("Light_GalleyStrip", "emit_strip")
    K.box(strip, (0.02, y1 - y0 - 0.1, 0.008), K.translate((xs - depth + 0.03, (y0 + y1) / 2, zs - 0.006)), "emit_strip", "B")
    parts.append(strip)
    shelf_top = zs + 0.03
    for k, (h, yy) in enumerate(((0.1, y0 + 0.2), (0.085, y0 + 0.31), (0.07, y0 + 0.41))):
        jar = K.Part(f"Galley_Jar_{k + 1}", "ceramic")
        r = 0.042 - 0.004 * k
        x = min(xs - depth + 0.06, wall_x(shelf_top + h + 0.02, 1) - r - 0.014)
        Mj = K.translate((x, yy, shelf_top))
        K.lathe(jar, [(0.0, -SINK), (r, -SINK), (r, h), (0.0, h)], Mj, 28, lambda q: "ceramic")
        K.lathe(jar, [(0.0, h - 0.004), (r + 0.002, h - 0.004), (r + 0.002, h + 0.012), (r * 0.4, h + 0.016), (0.0, h + 0.018)],
                Mj, 28, lambda q: "brass")
        parts.append(jar)
    # counter: tins in the back corner, the mug tree, herbs under the porthole, a board, the kettle at the front
    for k, (col, h) in enumerate((("enamel_red", 0.13), ("enamel_cream", 0.11), ("ceramic_dark", 0.15))):
        tin = K.Part(f"Galley_Tin_{k + 1}", col)
        M = K.translate((xw - 0.11, y0 + 0.12 + 0.1 * k, zt))
        K.lathe(tin, [(0.0, -SINK), (0.042, -SINK), (0.042, h), (0.0, h)], M, 28, lambda q: col)
        K.lathe(tin, [(0.0, h - 0.004), (0.044, h - 0.004), (0.044, h + 0.016), (0.0, h + 0.016)], M, 28, lambda q: "brass")
        parts.append(tin)
    Mt = K.translate((x_in + 0.16, y0 + 0.2, zt))
    tree = K.Part("Galley_MugTree", "walnut")
    K.lathe(tree, [(0.0, -SINK), (0.07, -SINK), (0.07, 0.02), (0.012, 0.025), (0.012, 0.32), (0.0, 0.33)], Mt, 24,
            lambda q: "walnut")
    hooks = []
    for a in (0.6, 2.7, 4.8):
        hk = K.apply(Mt, [(0.0, 0.0, 0.24), (0.07 * math.cos(a), 0.07 * math.sin(a), 0.2),
                          (0.085 * math.cos(a), 0.085 * math.sin(a), 0.222)])
        tube(tree, np.vstack([np.linspace(hk[0], hk[1], 4), np.linspace(hk[1], hk[2], 3)[1:]]), 0.0045, "walnut", 8)
        hooks.append((a, hk))
    parts.append(tree)
    for k, (a, hk) in enumerate(hooks[:2]):
        parts += mug(f"Galley_Mug_{k + 1}", hanging_mug_frame(hk[1], a), tea=False, glaze=("enamel_cream", "enamel_red")[k])
    board = K.Part("Galley_Board", "walnut")
    K.rbox(board, (0.22, 0.3, 0.018), 0.01, K.translate((x_in + 0.17, y0 + 0.62, zt - SINK)) @ K.rot_z(0.08), 2, "walnut")
    parts.append(board)
    for k, yy in enumerate((-1.53, -1.37)):
        parts += plant_bush(f"Plant_Herb_{k + 1}", K.translate((xw - 0.15, yy, zt)), rng, 8, 0.11, 0.07, 6, (0.018, 0.028),
                            0.045, 0.085)
    parts += kettle(K.translate((x_in + 0.17, y1 - 0.2, zt)) @ K.rot_z(math.pi))
    return parts


def kettle(Mk):
    parts = []
    kt = K.Part("Galley_Kettle", "ceramic_dark")
    K.lathe(kt, [(0.0, -SINK), (0.082, -SINK), (0.098, 0.05), (0.094, 0.12), (0.07, 0.16), (0.045, 0.172), (0.0, 0.174)],
            Mk, 36, lambda k: "ceramic_dark")
    spout = K.bezier((0.07, 0, 0.06), (0.13, 0, 0.08), (0.15, 0, 0.13), (0.17, 0, 0.15), 12)
    K.sweep(kt, K.apply(Mk, spout), K.circle_section(0.012, 8), zone_fn=lambda j: "ceramic_dark",
            scale=lambda i: 1.0 - 0.45 * i / 11)
    handle = K.bezier((-0.055, 0, 0.158), (-0.04, 0, 0.27), (0.04, 0, 0.27), (0.055, 0, 0.158), 16)
    K.sweep(kt, K.apply(Mk, handle), K.rounded_rect(0.014, 0.022, 0.005, 2), up=K.apply(Mk, [(0, 1, 0)])[0] - K.apply(Mk, [(0, 0, 0)])[0],
            zone_fn=lambda j: "walnut")
    K.lathe(kt, [(0.0, 0.168), (0.014, 0.168), (0.016, 0.185), (0.0, 0.192)], Mk, 16, lambda k: "walnut")
    parts.append(kt)
    return parts


# ============================================================================================== back wall
def back_wall():
    parts = []
    rng = np.random.default_rng(3)
    dx, dz, dw, dh, dr = L.DOOR
    yb = L.YB
    # door frame: a brass section swept round the opening, 1 cm into the wall
    frame = K.Part("Back_DoorFrame", "brass")
    o = K.rounded_rect(dw + 0.03, dh + 0.03, dr + 0.015, 8)
    path = np.column_stack([o[:, 0] + dx, np.full(len(o), yb + 0.015), o[:, 1] + dz + dh / 2])
    nrm = np.tile([0.0, 1.0, 0.0], (len(o), 1))
    K.sweep(frame, path, K.rounded_rect(0.09, 0.07, 0.01, 2), frames=K.section_frames(path, nrm), closed_path=True, caps=False,
            zone_fn=lambda j: "brass")
    parts.append(frame)
    # the hatch: teal enamel, set into the opening; its face 1 cm proud of the wall
    door = K.Part("Back_Door", "ceramic_dark")
    M = K.frame((dx, yb + 0.01, dz + dh / 2), (1, 0, 0), (0, 0, 1))         # local z = -y (into the wall)
    K.rbox(door, (dw - 0.01, dh - 0.01, 0.05), 0.02, M, 3, "ceramic_dark")
    parts.append(door)
    front = K.translate((0, yb + 0.01, 0)) @ K.rot_x(-math.pi / 2)        # local z -> +y (out of the door face)
    wheel = K.Part("Door_Wheel", "brass")
    Mw = K.translate((dx, 0, dz + 0.95)) @ front
    th = np.linspace(0, 2 * math.pi, 48, endpoint=False)
    R = 0.13
    K.sweep(wheel, K.apply(Mw, np.column_stack([R * np.cos(th), R * np.sin(th), np.full_like(th, 0.045)])),
            K.circle_section(0.011, 8), closed_path=True, caps=False, zone_fn=lambda j: "brass")
    for a in (0, math.pi / 2, math.pi, 3 * math.pi / 2):
        tube(wheel, K.apply(Mw, np.linspace((0.02 * math.cos(a), 0.02 * math.sin(a), 0.045), (R * math.cos(a), R * math.sin(a), 0.045), 4)),
             0.008, "brass", 8)
    K.lathe(wheel, [(0.0, -0.012), (0.03, -0.012), (0.03, 0.05), (0.024, 0.058), (0.0, 0.06)], Mw, 20, lambda k: "brass")
    parts.append(wheel)
    Mwin = K.translate((dx, 0, dz + 1.48)) @ front
    win = K.Part("Door_Window_Glass", "glass")
    K.lathe(win, [(0.0, -0.004), (0.104, -0.004), (0.104, 0.004), (0.0, 0.004)], Mwin, 32, lambda k: "glass")
    parts.append(win)
    winf = K.Part("Door_WindowFrame", "brass")
    K.lathe(winf, [(0.1, -0.006), (0.128, -0.006), (0.128, 0.008), (0.122, 0.014), (0.1, 0.012)], Mwin, 40, lambda k: "brass")
    parts.append(winf)
    # bookcase in the port corner: walnut carcass, four shelves of books, a plant on top
    x0, x1 = -1.08, -0.52
    y_case = yb + 0.005
    depth = 0.26
    case = K.Part("Back_Bookcase", "walnut")
    shelves_z = (0.02, 0.34, 0.66, 0.98, 1.3)
    H = shelves_z[-1] + 0.022
    for x in (x0, x1):
        K.rbox(case, (0.022, depth, H), 0.004, K.translate((x, y_case + depth / 2, -SINK)), 2, "walnut")
    K.rbox(case, (x1 - x0 + 0.02, 0.012, H - 0.02), 0.002, K.translate(((x0 + x1) / 2, y_case + 0.006, 0.0)), 2, "walnut")
    for z in shelves_z:
        K.rbox(case, (x1 - x0 + 0.01, depth, 0.022), 0.004, K.translate(((x0 + x1) / 2, y_case + depth / 2, z)), 2, "walnut")
    parts.append(case)
    nb = 0
    for si, z in enumerate(shelves_z[:-1]):
        base = z + 0.022 - SINK
        x = x0 + 0.011 + 0.0015
        stack_at = rng.uniform(0.55, 0.8) if si % 2 == 0 else None
        while x < x1 - 0.011 - 0.05:
            if stack_at is not None and x > x0 + stack_at * (x1 - x0):
                # a short stack lying flat to finish the row
                zz = base
                for k in range(rng.integers(2, 4)):
                    bw, bd, bt = rng.uniform(0.15, 0.2), rng.uniform(0.2, 0.23), rng.uniform(0.022, 0.035)
                    if x + bw > x1 - 0.012:
                        break
                    Mb = K.translate((x + bw / 2 + 0.002, y_case + depth / 2 + 0.01, zz)) @ K.rot_z(rng.uniform(-0.04, 0.04))
                    parts.append(hardcover(f"Back_Book_{nb:02d}", Mb @ K.rot_z(math.pi / 2), bd, bw, bt))
                    nb += 1
                    zz += bt - 0.0004
                break
            w = rng.uniform(0.022, 0.045)
            h = rng.uniform(0.19, 0.28)
            d = rng.uniform(0.17, 0.21)
            bk = K.Part(f"Back_Book_{nb:02d}", "book")
            K.rbox(bk, (w, d, h), 0.0025, K.translate((x + w / 2, y_case + depth - d / 2 - 0.012, base)), 2, "book")
            spine = y_case + depth - 0.012
            for zb_ in ((0.78,) if rng.random() < 0.6 else (0.12, 0.8)):
                K.box(bk, (w * 0.72, 0.0012, 0.008 + 0.006 * rng.random()), K.translate((x + w / 2, spine - 0.0008, base + h * zb_)),
                      "brass")
            parts.append(bk)
            nb += 1
            x += w - 0.0004
    parts += plant_bush("Plant_Bookcase", K.translate((x0 + 0.12, y_case + depth / 2, shelves_z[-1] + 0.022)),
                        np.random.default_rng(19), 7, 0.14, 0.1, 5, (0.03, 0.045), 0.055, 0.1)
    # framed star chart right of the door
    Mf = K.translate((0.78, yb - HANG_EMBED, 1.55)) @ K.rot_x(-math.pi / 2)
    fr = K.Part("Back_Frame", "walnut")
    K.frame_ring(fr, (0.44, 0.56), (0.38, 0.5), 0.006, 0.002, 0.0, 0.028, Mf, "walnut")
    parts.append(fr)
    chart = K.Part("Back_Chart", "chart")
    K.box(chart, (0.384, 0.504, 0.012), Mf, "chart")
    parts.append(pivot(chart, Mf))
    # coat hooks with a scarf over the first
    hooks = K.Part("Back_Hooks", "walnut")
    K.rbox(hooks, (0.42, 0.1, 0.022), 0.006,
           K.translate((0.78, yb - HANG_EMBED - 0.007, 1.1)) @ K.rot_x(-math.pi / 2) @ K.translate((0, 0, -0.0)), 2, "walnut")
    hook_x = (0.66, 0.78, 0.9)
    for x in hook_x:
        tube(hooks, np.array([(x, yb + 0.008, 1.1), (x, yb + 0.06, 1.1), (x, yb + 0.09, 1.104), (x, yb + 0.1, 1.13)]), 0.006,
             "brass", 8)
    parts.append(hooks)
    scarf = K.Part("Back_Scarf", "fabric_rust")
    x = hook_x[0]
    top = 1.1 + 0.006 + 0.006 + 0.003
    pts = [(yb + 0.026, 0.84), (yb + 0.024, 0.96), (yb + 0.026, 1.06), (yb + 0.034, 1.095), (yb + 0.05, top),
           (yb + 0.066, 1.095), (yb + 0.074, 1.06), (yb + 0.078, 0.95), (yb + 0.08, 0.80)]
    ys_, zs_ = zip(*pts)
    path = np.column_stack([np.full(len(pts), x), ys_, zs_])
    yz = np.asarray(pts)
    for _ in range(3):                                       # Chaikin: soft folds, ends kept
        q = 0.75 * yz[:-1] + 0.25 * yz[1:]
        r_ = 0.25 * yz[:-1] + 0.75 * yz[1:]
        yz = np.vstack([yz[:1], np.column_stack([q, r_]).reshape(-1, 2), yz[-1:]])
    path = np.column_stack([np.full(len(yz), x), yz[:, 0], yz[:, 1]])
    K.sweep(scarf, path, K.rounded_rect(0.09, 0.012, 0.005, 2), up=(1, 0, 0), zone_fn=lambda j: "fabric_rust")
    parts.append(scarf)
    return parts


# ============================================================================================== ceiling
def pendant():
    """ceiling rose, cord, a socket with a collar holding a dome shade, the bulb hanging in it"""
    parts = []
    x, y, zb = L.PENDANT
    ztop = L.ZC + L.B
    rose = K.Part("Pendant_Rose", "brass")
    K.lathe(rose, [(0.0, ztop - 0.035), (0.045, ztop - 0.035), (0.052, ztop - 0.028), (0.052, ztop + 0.02), (0.0, ztop + 0.02)],
            K.translate((x, y, 0)), 32, lambda k: "brass")
    parts.append(rose)
    cord = K.Part("Pendant_Cord", "rubber")
    K.lathe(cord, [(0.0, zb + 0.26), (0.0035, zb + 0.26), (0.0035, ztop - 0.03), (0.0, ztop - 0.03)], K.translate((x, y, 0)), 8,
            lambda k: "rubber")
    parts.append(cord)
    cap = K.Part("Pendant_Cap", "brass")
    K.lathe(cap, [(0.0, zb + 0.16), (0.016, zb + 0.16), (0.016, zb + 0.205), (0.034, zb + 0.21), (0.036, zb + 0.236),
                  (0.03, zb + 0.262), (0.008, zb + 0.272), (0.0, zb + 0.273)], K.translate((x, y, 0)), 28, lambda k: "brass")
    parts.append(cap)
    shade = K.Part("Pendant_Shade", "shade_fabric")
    prof = [(0.03, zb + 0.24), (0.11, zb + 0.2), (0.17, zb + 0.11), (0.2, zb), (0.196, zb), (0.165, zb + 0.108),
            (0.107, zb + 0.196), (0.028, zb + 0.236)]
    K.lathe(shade, prof, K.translate((x, y, 0)), 48, lambda k: "shade_fabric")
    parts.append(shade)
    bulb = K.Part("Light_PendantBulb", "emit_warm")
    K.lathe(bulb, [(0.0, zb + 0.035), (0.03, zb + 0.05), (0.042, zb + 0.085), (0.036, zb + 0.12), (0.018, zb + 0.15),
                   (0.013, zb + 0.165), (0.0, zb + 0.17)], K.translate((x, y, 0)), 20, lambda k: "emit_warm", group="A")
    parts.append(bulb)
    rx, ry, rr = L.RUG
    rug = K.Part("Rug", "rug")
    K.lathe(rug, [(0.0, -0.002), (rr, -0.002), (rr + 0.004, 0.004), (rr, 0.011), (0.0, 0.011)], K.translate((rx, ry, 0)), 72,
            lambda k: "rug")
    parts.append(rug)
    return parts


HANGING = (-1.05, -0.66, 1.62)


def hanging_plant():
    """a trailing plant in a pot hung from the ceiling by three cords from a brass ring on a ceiling plate"""
    parts = []
    rng = np.random.default_rng(21)
    x, y, pot_z = HANGING
    th = math.asin(x / L.A)
    cx, cz = L.section_xz(th)
    n = L.cylinder_normal_in(np.array(th))
    hook = K.Part("Hanger_Hook", "brass")
    Mp = K.frame((cx, y, cz), (0, 1.0, 0), np.cross(n, (0, 1.0, 0)))
    Mp[:3, 2] = n
    K.lathe(hook, [(0.0, -0.02), (0.028, -0.02), (0.028, 0.004), (0.02, 0.01), (0.0, 0.011)], Mp, 24, lambda k: "brass")
    ring_c = np.array([cx, y, cz]) + n * 0.01 + np.array([0, 0, -0.022])
    ringpts = [ring_c + 0.016 * np.array([0, math.cos(a), math.sin(a)]) for a in np.linspace(0, 2 * math.pi, 24, endpoint=False)]
    K.sweep(hook, np.array(ringpts), K.circle_section(0.0035, 8), closed_path=True, caps=False, zone_fn=lambda j: "brass")
    tube(hook, np.linspace(np.array([cx, y, cz]) + n * 0.008, ring_c + np.array([0, 0, 0.016]), 4), 0.003, "brass", 8)
    parts.append(hook)
    pot_r, pot_h = 0.075, 0.12
    cords = K.Part("Hanger_Cords", "fabric_cream")
    knot = ring_c + np.array([0, 0, -0.018])
    for a in (0.4, 0.4 + 2 * math.pi / 3, 0.4 + 4 * math.pi / 3):
        rim = np.array([x + (pot_r + 0.004) * math.cos(a), y + (pot_r + 0.004) * math.sin(a), pot_z + pot_h - 0.006])
        tube(cords, np.linspace(knot, rim, 10), 0.003, "fabric_cream", 6)
    sphere(cords, knot, 0.009, "fabric_cream", 10)
    parts.append(cords)
    parts += plant_trail("Plant_Hanging", K.translate((x, y, pot_z)), rng, 7, 0.42, 0.11, 8, (0.032, 0.05), pot_r, pot_h)
    return parts
