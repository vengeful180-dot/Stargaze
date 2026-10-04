"""meshkit.py - closed-solid mesh building blocks for the Stargaze cabin (Blender 5.2 bpy + numpy).

Every builder appends to a Part: vertices, faces, a material zone per face and an optional light group per face.
Parts are closed outward-wound solids (orient_consistent + signed volume) - the skill's rule 6; the cabin checks
assert it again on the Blender meshes. Frames are 4x4 numpy matrices (column vectors): world = M @ local.
"""
import math
from collections import defaultdict, deque

import numpy as np

TAU = 2.0 * math.pi


# ============================================================================================== frames
def frame(origin=(0, 0, 0), x=(1, 0, 0), y=(0, 1, 0), z=None):
    """4x4 matrix from an origin and two axes (x, y); z = x cross y. Axes are orthonormalised (x kept)."""
    x = np.asarray(x, np.float64)
    x = x / np.linalg.norm(x)
    y = np.asarray(y, np.float64)
    y = y - x * np.dot(x, y)
    y = y / np.linalg.norm(y)
    zz = np.cross(x, y) if z is None else np.asarray(z, np.float64)
    M = np.eye(4)
    M[:3, 0], M[:3, 1], M[:3, 2], M[:3, 3] = x, y, zz, origin
    return M


def translate(t):
    M = np.eye(4)
    M[:3, 3] = t
    return M


def rot_z(a):
    c, s = math.cos(a), math.sin(a)
    M = np.eye(4)
    M[0, 0], M[0, 1], M[1, 0], M[1, 1] = c, -s, s, c
    return M


def rot_x(a):
    c, s = math.cos(a), math.sin(a)
    M = np.eye(4)
    M[1, 1], M[1, 2], M[2, 1], M[2, 2] = c, -s, s, c
    return M


def rot_y(a):
    c, s = math.cos(a), math.sin(a)
    M = np.eye(4)
    M[0, 0], M[0, 2], M[2, 0], M[2, 2] = c, s, -s, c
    return M


def apply(M, pts):
    pts = np.asarray(pts, np.float64).reshape(-1, 3)
    return pts @ M[:3, :3].T + M[:3, 3]


# ============================================================================================== part
class Part:
    """vertices, faces, per-face zone (material name) and light group ('' = none)"""

    def __init__(self, name, zone="default"):
        self.name = name
        self.default_zone = zone
        self.V = []
        self.F = []
        self.zone = []
        self.group = []
        self.meta = {}

    def vs(self, pts, M=None):
        pts = np.asarray(pts, np.float64).reshape(-1, 3)
        if M is not None:
            pts = apply(M, pts)
        base = len(self.V)
        self.V.extend(map(tuple, pts.tolist()))
        return base

    def f(self, idx, zone=None, group=""):
        idx = tuple(int(i) for i in idx)
        if len(set(idx)) != len(idx):
            raise ValueError(f"{self.name}: degenerate face {idx}")
        self.F.append(idx)
        self.zone.append(zone or self.default_zone)
        self.group.append(group)
        return len(self.F) - 1

    def merge(self, other, M=None):
        base = self.vs(other.V, M)
        for f, z, g in zip(other.F, other.zone, other.group):
            self.F.append(tuple(i + base for i in f))
            self.zone.append(z)
            self.group.append(g)
        return base

    def transform(self, M):
        if self.V:
            self.V = list(map(tuple, apply(M, self.V).tolist()))
        return self

    def flip(self):
        self.F = [tuple(reversed(f)) for f in self.F]

    def signed_volume(self):
        P = np.asarray(self.V)
        vol = 0.0
        for f in self.F:
            a = P[f[0]]
            for i in range(1, len(f) - 1):
                vol += np.dot(a, np.cross(P[f[i]], P[f[i + 1]])) / 6.0
        return vol

    def open_edges(self):
        cnt = defaultdict(int)
        for f in self.F:
            for i in range(len(f)):
                a, b = f[i], f[(i + 1) % len(f)]
                cnt[(min(a, b), max(a, b))] += 1
        return sum(1 for c in cnt.values() if c != 2)

    def bounds(self):
        P = np.asarray(self.V)
        return P.min(0), P.max(0)

    def finalize(self):
        """consistent winding per connected piece, then outward by signed volume per piece"""
        orient_consistent(self)
        for comp in components(self):
            vol = 0.0
            P = np.asarray(self.V)
            for fi in comp:
                f = self.F[fi]
                a = P[f[0]]
                for i in range(1, len(f) - 1):
                    vol += np.dot(a, np.cross(P[f[i]], P[f[i + 1]])) / 6.0
            if vol < 0:
                for fi in comp:
                    self.F[fi] = tuple(reversed(self.F[fi]))
        return self


def components(P):
    """face index lists of edge-connected pieces"""
    ef = defaultdict(list)
    for fi, f in enumerate(P.F):
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            ef[(min(a, b), max(a, b))].append(fi)
    seen = [False] * len(P.F)
    out = []
    for s in range(len(P.F)):
        if seen[s]:
            continue
        seen[s] = True
        q = deque([s])
        comp = []
        while q:
            fi = q.popleft()
            comp.append(fi)
            f = P.F[fi]
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                for g in ef[(min(a, b), max(a, b))]:
                    if not seen[g]:
                        seen[g] = True
                        q.append(g)
        out.append(comp)
    return out


def orient_consistent(P):
    ef = defaultdict(list)
    for fi, f in enumerate(P.F):
        for k in range(len(f)):
            a, b = f[k], f[(k + 1) % len(f)]
            ef[(min(a, b), max(a, b))].append((fi, a, b))
    flip = [None] * len(P.F)
    for start in range(len(P.F)):
        if flip[start] is not None:
            continue
        flip[start] = False
        dq = deque([start])
        while dq:
            fi = dq.popleft()
            f = P.F[fi]
            for k in range(len(f)):
                a, b = f[k], f[(k + 1) % len(f)]
                if flip[fi]:
                    a, b = b, a
                for gj, ga, gb in ef[(min(a, b), max(a, b))]:
                    if gj == fi:
                        continue
                    want = ga == a and gb == b
                    if flip[gj] is None:
                        flip[gj] = want
                        dq.append(gj)
                    elif flip[gj] != want:
                        raise RuntimeError(f"{P.name}: non-orientable surface at edge {a}-{b}")
    for fi, fl in enumerate(flip):
        if fl:
            P.F[fi] = tuple(reversed(P.F[fi]))


# ============================================================================================== grids
def grid_rings(P, rings, zone_fn=None, wrap=True, group=""):
    """quads between consecutive rings of vertex indices (equal length). zone_fn(i, j) or None."""
    m = len(rings[0])
    for i in range(len(rings) - 1):
        ra, rb = rings[i], rings[i + 1]
        for j in range(m if wrap else m - 1):
            j2 = (j + 1) % m
            P.f((ra[j], ra[j2], rb[j2], rb[j]), zone_fn(i, j) if zone_fn else None, group)


def fan(P, centre, ring, reverse=False, zone=None, group=""):
    m = len(ring)
    for j in range(m):
        j2 = (j + 1) % m
        P.f((centre, ring[j2], ring[j]) if not reverse else (centre, ring[j], ring[j2]), zone, group)


def cap_ring(P, ring, reverse=False, zone=None, group="", centre=None):
    """close a ring with a fan from its centre - only valid when every ring point is visible from that centre (rounded
    rectangles, lathe rings). For arcs and other non-convex outlines use cap_polygon: a fan from the point mean of
    the console desk's 164 deg sector sat OUTSIDE it and folded ghost triangles over the floor in front of the seat."""
    pts = np.asarray([P.V[i] for i in ring])
    c = pts.mean(0) if centre is None else np.asarray(centre)
    if centre is None and not _star_shaped(pts, c):
        return cap_polygon(P, ring, reverse, zone, group)
    c = P.vs([c])
    fan(P, c, ring, reverse, zone, group)
    return c


def _plane_2d(pts):
    c = pts.mean(0)
    _, _, vt = np.linalg.svd(pts - c)
    return (pts - c) @ vt[0], (pts - c) @ vt[1]


def _star_shaped(pts, c):
    """every edge of the (planar) ring turns the same way seen from c"""
    q = np.vstack([pts, c[None]])
    u, v = _plane_2d(q)
    cu, cv = u[-1], v[-1]
    u, v = u[:-1] - cu, v[:-1] - cv
    cross = u * np.roll(v, -1) - v * np.roll(u, -1)
    return bool(np.all(cross > 1e-12) or np.all(cross < -1e-12))


def cap_polygon(P, ring, reverse=False, zone=None, group=""):
    """ear-clipping triangulation of a planar ring (no new vertex). Orientation follows the fan convention: the
    triangles wind like (c, ring[j+1], ring[j]) would, flipped when reverse is True."""
    pts = np.asarray([P.V[i] for i in ring])
    u, v = _plane_2d(pts)
    area = 0.5 * np.sum(u * np.roll(v, -1) - np.roll(u, -1) * v)
    idx = list(range(len(ring)))
    if area < 0:                                   # work counter-clockwise in the plane
        idx.reverse()
    tris = []

    def cross(a, b, c):
        return (u[b] - u[a]) * (v[c] - v[a]) - (v[b] - v[a]) * (u[c] - u[a])

    eps = 1e-12 * max(1e-6, float(np.ptp(u) * np.ptp(v)))

    def inside(p, a, b, c):
        return cross(a, b, p) > eps and cross(b, c, p) > eps and cross(c, a, p) > eps

    guard = 0
    while len(idx) > 3 and guard < 100000:
        guard += 1
        n = len(idx)
        reflex = [idx[k] for k in range(n) if cross(idx[(k - 1) % n], idx[k], idx[(k + 1) % n]) <= eps]
        for k in range(n):
            a, b, c = idx[(k - 1) % n], idx[k], idx[(k + 1) % n]
            if cross(a, b, c) <= eps:
                continue
            if any(inside(p, a, b, c) for p in reflex if p not in (a, b, c)):
                continue
            tris.append((a, b, c))
            idx.pop(k)
            break
        else:
            raise RuntimeError(f"{P.name}: cap_polygon found no ear (self-intersecting outline?)")
    tris.append(tuple(idx))
    # the fan (c, ring[j2], ring[j]) winds opposite to the ring's own order; match it
    flip = (area > 0) != bool(reverse)
    for a, b, c in tris:
        t = (ring[a], ring[b], ring[c])
        P.f(t[::-1] if flip else t, zone, group)
    return None


# ============================================================================================== primitives
def rounded_rect(w, d, r, seg=6):
    """closed CCW outline of a w x d rectangle centred at 0 with corner radius r (seg points per corner)"""
    r = min(r, w / 2 - 1e-6, d / 2 - 1e-6)
    out = []
    corners = [(w / 2 - r, d / 2 - r, 0.0), (-w / 2 + r, d / 2 - r, 0.5 * math.pi), (-w / 2 + r, -d / 2 + r, math.pi),
               (w / 2 - r, -d / 2 + r, 1.5 * math.pi)]
    for cx, cy, a0 in corners:
        for k in range(seg + 1):
            a = a0 + 0.5 * math.pi * k / seg
            out.append((cx + r * math.cos(a), cy + r * math.sin(a)))
    return np.asarray(out)


def slab(P, w, d, profile, corner_r, M=None, seg=6, zone_fn=None, group=""):
    """ring stack along an edge profile: profile = [(inset, z)] from bottom centre ... top centre.
    Each sample is a rounded rectangle shrunk by `inset` at height z. First and last rings are capped.
    zone_fn(k) -> zone of the band between profile samples k and k+1 (k = -1 bottom cap, len-1 top cap)."""
    rings = []
    for inset, z in profile:
        o = rounded_rect(w - 2 * inset, d - 2 * inset, max(1e-4, corner_r - inset), seg)
        pts = np.column_stack([o, np.full(len(o), z)])
        b = P.vs(pts, M)
        rings.append(list(range(b, b + len(o))))
    zf = (lambda i, j: zone_fn(i)) if zone_fn else None
    grid_rings(P, rings, zf, group=group)
    cap_ring(P, rings[0], reverse=True, zone=zone_fn(-1) if zone_fn else None, group=group)
    cap_ring(P, rings[-1], reverse=False, zone=zone_fn(len(profile) - 1) if zone_fn else None, group=group)
    return rings


def rbox(P, size, r, M=None, seg=4, zone=None, group=""):
    """box with rounded vertical edges and rounded top/bottom edges (radius r), base at z = 0, centred in x, y"""
    w, d, h = size
    r = min(r, h / 2.01, w / 2.01, d / 2.01)
    prof = [(r, 0.0)]
    for k in range(1, seg + 1):
        a = 0.5 * math.pi * k / seg
        prof.append((r - r * math.sin(a), r - r * math.cos(a)))
    for k in range(0, seg + 1):
        a = 0.5 * math.pi * k / seg
        prof.append((r - r * math.cos(a), h - r + r * math.sin(a)))
    prof[-1] = (r, h)
    return slab(P, w, d, prof, r * 1.001 + 1e-4, M, seg, (lambda k: zone), group)


def box(P, size, M=None, zone=None, group=""):
    """plain box, base at z = 0, centred in x, y"""
    w, d, h = size
    pts = [(-w / 2, -d / 2, 0), (w / 2, -d / 2, 0), (w / 2, d / 2, 0), (-w / 2, d / 2, 0),
           (-w / 2, -d / 2, h), (w / 2, -d / 2, h), (w / 2, d / 2, h), (-w / 2, d / 2, h)]
    b = P.vs(pts, M)
    for q in ((0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)):
        P.f([b + i for i in q], zone, group)


def lathe(P, profile, M=None, nseg=32, zone_fn=None, closed=True, group="", a0=0.0, a1=TAU):
    """revolve [(r, z)] about local +z. r == 0 points become poles. closed=True joins last to first."""
    full = abs(a1 - a0 - TAU) < 1e-9
    th = np.linspace(a0, a1, nseg, endpoint=not full)
    rings = []
    poles = {}
    for k, (r, z) in enumerate(profile):
        if r < 1e-9:
            poles[k] = P.vs([(0.0, 0.0, z)], M)
            rings.append(None)
            continue
        pts = np.column_stack([r * np.cos(th), r * np.sin(th), np.full(len(th), z)])
        b = P.vs(pts, M)
        rings.append(list(range(b, b + len(th))))
    n = len(profile)
    m = len(th)
    last = n if closed else n - 1
    for k in range(last):
        k2 = (k + 1) % n
        ra, rb = rings[k], rings[k2]
        z = zone_fn(k) if zone_fn else None
        if ra is None and rb is None:
            continue
        rng = range(m) if full else range(m - 1)
        for j in rng:
            j2 = (j + 1) % m
            if ra is None:
                P.f((poles[k], rb[j2], rb[j]), z, group)
            elif rb is None:
                P.f((ra[j], ra[j2], poles[k2]), z, group)
            else:
                P.f((ra[j], ra[j2], rb[j2], rb[j]), z, group)
    return rings


def rmf_frames(path, up=(0, 0, 1)):
    """rotation-minimising frames along a polyline: list of (t, n, b)"""
    path = np.asarray(path, np.float64)
    T = np.gradient(path, axis=0)
    T /= np.linalg.norm(T, axis=1, keepdims=True)
    up = np.asarray(up, np.float64)
    n0 = up - T[0] * np.dot(up, T[0])
    if np.linalg.norm(n0) < 1e-6:
        n0 = np.cross(T[0], [1, 0, 0])
    n0 /= np.linalg.norm(n0)
    frames = [(T[0], n0, np.cross(T[0], n0))]
    for i in range(1, len(path)):
        t0, n_prev, _ = frames[-1]
        t1 = T[i]
        # double reflection (Wang et al. 2008)
        v1 = path[i] - path[i - 1]
        c1 = np.dot(v1, v1)
        if c1 < 1e-18:
            frames.append((t1, n_prev, np.cross(t1, n_prev)))
            continue
        rL = n_prev - (2 / c1) * np.dot(v1, n_prev) * v1
        tL = t0 - (2 / c1) * np.dot(v1, t0) * v1
        v2 = t1 - tL
        c2 = np.dot(v2, v2)
        n1 = rL - (2 / c2) * np.dot(v2, rL) * v2 if c2 > 1e-18 else rL
        n1 -= t1 * np.dot(n1, t1)
        n1 /= np.linalg.norm(n1)
        frames.append((t1, n1, np.cross(t1, n1)))
    return frames


def sweep(P, path, section, up=(0, 0, 1), closed_path=False, caps=True, zone_fn=None, group="", frames=None,
          scale=None):
    """sweep a closed 2D section [(u, v)] (u along the frame normal, v along the binormal) along a 3D path.
    zone_fn(j) -> zone of the band between section points j, j+1. scale(i) -> section scale at path point i."""
    path = np.asarray(path, np.float64)
    fr = frames or rmf_frames(path, up)
    sec = np.asarray(section, np.float64)
    rings = []
    for i, (p, (t, n, b)) in enumerate(zip(path, fr)):
        s = scale(i) if scale else 1.0
        pts = p + s * (np.outer(sec[:, 0], n) + np.outer(sec[:, 1], b))
        base = P.vs(pts)
        rings.append(list(range(base, base + len(sec))))
    if closed_path:
        rings.append(rings[0])
    m = len(sec)
    for i in range(len(rings) - 1):
        ra, rb = rings[i], rings[i + 1]
        for j in range(m):
            j2 = (j + 1) % m
            P.f((ra[j], ra[j2], rb[j2], rb[j]), zone_fn(j) if zone_fn else None, group)
    if caps and not closed_path:
        cap_ring(P, rings[0], reverse=False, zone=zone_fn(-1) if zone_fn else None, group=group)
        cap_ring(P, rings[-1], reverse=True, zone=zone_fn(-1) if zone_fn else None, group=group)
    return rings


def rounded_section(w, h, r, seg=3):
    """closed CCW rounded rectangle section (u in [-w/2, w/2], v in [-h/2, h/2])"""
    return rounded_rect(w, h, r, seg)


def circle_section(r, n=12):
    a = np.linspace(0, TAU, n, endpoint=False)
    return np.column_stack([r * np.cos(a), r * np.sin(a)])


def catenary(p0, p1, sag, n=24):
    """points of a hanging curve between p0 and p1 sagging `sag` metres at the middle (parabola approximation)"""
    p0, p1 = np.asarray(p0, np.float64), np.asarray(p1, np.float64)
    t = np.linspace(0, 1, n)
    pts = p0 + np.outer(t, p1 - p0)
    pts[:, 2] -= sag * 4 * t * (1 - t)
    return pts


def bezier(p0, p1, p2, p3, n=24):
    t = np.linspace(0, 1, n)[:, None]
    p0, p1, p2, p3 = (np.asarray(p, np.float64) for p in (p0, p1, p2, p3))
    return (1 - t) ** 3 * p0 + 3 * (1 - t) ** 2 * t * p1 + 3 * (1 - t) * t ** 2 * p2 + t ** 3 * p3


# ============================================================================================== surfaces -> solids
def thick_patch(P, S, N, us, vs, T, keep=None, zone_fn=None, out_zone="hidden", rim_zone=None, group=""):
    """thicken a parametric surface patch into a closed solid. S(u, v) -> point, N(u, v) -> unit normal pointing to
    the visible side; the back surface sits T behind. keep(i, j) selects grid cells (holes allowed)."""
    nu, nv = len(us), len(vs)
    inner = np.array([[S(u, v) for v in vs] for u in us], np.float64)
    nrm = np.array([[N(u, v) for v in vs] for u in us], np.float64)
    outer = inner - nrm * T
    bi = P.vs(inner.reshape(-1, 3))
    bo = P.vs(outer.reshape(-1, 3))

    def vi(i, j):
        return bi + i * nv + j

    def vo(i, j):
        return bo + i * nv + j

    kept = np.zeros((nu - 1, nv - 1), bool)
    for i in range(nu - 1):
        for j in range(nv - 1):
            kept[i, j] = keep(i, j) if keep else True
    for i in range(nu - 1):
        for j in range(nv - 1):
            if not kept[i, j]:
                continue
            z = zone_fn(i, j) if zone_fn else None
            P.f((vi(i, j), vi(i + 1, j), vi(i + 1, j + 1), vi(i, j + 1)), z, group)
            P.f((vo(i, j), vo(i, j + 1), vo(i + 1, j + 1), vo(i + 1, j)), out_zone, group)
    rz = rim_zone or (zone_fn(0, 0) if zone_fn else None)
    # rims along every boundary edge of the kept region (outer border and holes)
    for i in range(nu - 1):
        for j in range(nv - 1):
            if not kept[i, j]:
                continue
            edges = (((i, j), (i + 1, j), (i, j - 1)), ((i + 1, j), (i + 1, j + 1), (i + 1, j)),
                     ((i + 1, j + 1), (i, j + 1), (i, j + 1)), ((i, j + 1), (i, j), (i - 1, j)))
            for (a, b, nb) in edges:
                ni, nj = nb
                if 0 <= ni < nu - 1 and 0 <= nj < nv - 1 and kept[ni, nj]:
                    continue
                P.f((vi(*a), vo(*a), vo(*b), vi(*b)), rz, group)
    return inner, nrm


def compact(P):
    """drop vertices no face uses (holes in thickened grids leave some)"""
    used = sorted({i for f in P.F for i in f})
    remap = {o: n for n, o in enumerate(used)}
    P.V = [P.V[i] for i in used]
    P.F = [tuple(remap[i] for i in f) for f in P.F]
    return P


def extrude_outline(P, outline, z0, z1, M=None, zone=None, side_zone=None, bottom_zone="hidden", group=""):
    """prism over a closed CCW plan outline (convex or star-shaped from its centroid)"""
    o = np.asarray(outline, np.float64)
    n = len(o)
    b0 = P.vs(np.column_stack([o, np.full(n, z0)]), M)
    b1 = P.vs(np.column_stack([o, np.full(n, z1)]), M)
    for j in range(n):
        j2 = (j + 1) % n
        P.f((b0 + j, b0 + j2, b1 + j2, b1 + j), side_zone or zone, group)
    cap_ring(P, list(range(b1, b1 + n)), reverse=False, zone=zone, group=group)
    cap_ring(P, list(range(b0, b0 + n)), reverse=True, zone=bottom_zone, group=group)


def sector_outline(r0, r1, a0, a1, rc, inset=0.0, n_arc=64, n_corner=5, c=(0.0, 0.0)):
    """closed CCW plan outline of an annular sector. Angles are compass bearings (0 = forward +Y, positive toward
    +X: x = r sin a, y = r cos a). Corners get fillets of radius rc; `inset` offsets the whole outline inward.
    The point count does not depend on `inset`, so offsets can be bridged into ring stacks."""
    R0, R1 = r0 + inset, r1 - inset
    rc = max(1e-4, rc - inset)

    def pt(r, a):
        return (c[0] + r * math.sin(a), c[1] + r * math.cos(a))

    out = []
    for a in np.linspace(a0 + rc / R1, a1 - rc / R1, n_arc):           # outer arc, bearing increasing
        out.append(pt(R1, a))
    for k in range(1, n_corner + 1):                                     # outer corner at a1
        t = 0.5 * math.pi * k / n_corner
        r = R1 - rc + rc * math.cos(t)
        out.append(pt(r, a1 - (rc - rc * math.sin(t)) / r))
    for k in range(0, n_corner):                                         # inner corner at a1
        t = 0.5 * math.pi * k / n_corner
        r = R0 + rc - rc * math.sin(t)
        out.append(pt(r, a1 - (rc - rc * math.cos(t)) / r))
    for a in np.linspace(a1 - rc / R0, a0 + rc / R0, n_arc):           # inner arc, bearing decreasing
        out.append(pt(R0, a))
    for k in range(1, n_corner + 1):                                     # inner corner at a0
        t = 0.5 * math.pi * k / n_corner
        r = R0 + rc - rc * math.cos(t)
        out.append(pt(r, a0 + (rc - rc * math.sin(t)) / r))
    for k in range(0, n_corner):                                         # outer corner at a0
        t = 0.5 * math.pi * k / n_corner
        r = R1 - rc + rc * math.sin(t)
        out.append(pt(r, a0 + (rc - rc * math.cos(t)) / r))
    out = np.asarray(out)
    area = 0.5 * np.sum(out[:, 0] * np.roll(out[:, 1], -1) - np.roll(out[:, 0], -1) * out[:, 1])
    return out if area > 0 else out[::-1]


def outline_slab(P, outline_fn, profile, M=None, zone_fn=None, group=""):
    """ring stack: outline_fn(inset) -> closed CCW outline (same point count for every inset); profile [(inset, z)].
    outline_fn may also take (inset, z) - then the outline can change with height (a carcass that follows a wall)."""
    import inspect
    two = len(inspect.signature(outline_fn).parameters) >= 2
    rings = []
    for inset, z in profile:
        o = outline_fn(inset, z) if two else outline_fn(inset)
        b = P.vs(np.column_stack([o, np.full(len(o), z)]), M)
        rings.append(list(range(b, b + len(o))))
    grid_rings(P, rings, (lambda i, j: zone_fn(i)) if zone_fn else None, group=group)
    cap_ring(P, rings[0], reverse=True, zone=zone_fn(-1) if zone_fn else None, group=group)
    cap_ring(P, rings[-1], reverse=False, zone=zone_fn(len(profile) - 1) if zone_fn else None, group=group)
    return rings


def round_profile(t, r, seg=4, top_only=True, z0=0.0, n_mid=0):
    """edge profile [(inset, z)] for a slab of thickness t from z0 with a round-over of radius r on the top edge
    (and the bottom edge when top_only is False). n_mid extra straight rings in between (for outlines that change
    with height)."""
    if top_only:
        prof = [(0.004, 0.0), (0.0, 0.004)]
    else:
        prof = [(r, 0.0)] + [(r - r * math.sin(0.5 * math.pi * k / seg), r - r * math.cos(0.5 * math.pi * k / seg))
                             for k in range(1, seg + 1)]
    lo = prof[-1][1]
    hi = t - r
    for k in range(1, n_mid + 1):
        prof.append((0.0, lo + (hi - lo) * k / (n_mid + 1)))
    for k in range(seg + 1):
        a = 0.5 * math.pi * k / seg
        prof.append((r - r * math.cos(a), t - r + r * math.sin(a)))
    prof[-1] = (r, t)
    return [(i, z + z0) for i, z in prof]


def section_frames(path, normals, tangents=None):
    """frames for sweep: (t, n, b) with n = given (inward) normal, b = t x n"""
    path = np.asarray(path)
    T = np.gradient(path, axis=0) if tangents is None else tangents
    T = T / np.linalg.norm(T, axis=1, keepdims=True)
    out = []
    for t, n in zip(T, normals):
        n = n - t * np.dot(n, t)
        n /= np.linalg.norm(n)
        out.append((t, n, np.cross(t, n)))
    return out


def ring_band(P, outline, z0, z1, M=None, zone=None, group=""):
    """closed prism between two copies of a 2D outline at z0 and z1 (alias kept short for prop code)"""
    extrude_outline(P, outline, z0, z1, M, zone=zone, side_zone=zone, bottom_zone=zone, group=group)


def frame_ring(P, outer_wh, inner_wh, r_out, r_in, z0, z1, M=None, zone=None, seg=4, group=""):
    """a flat rectangular frame (bezel, picture frame): rounded outer and inner outlines, closed solid z0..z1"""
    ring = rounded_rect(outer_wh[0], outer_wh[1], r_out, seg)
    hole = rounded_rect(inner_wh[0], inner_wh[1], r_in, seg)
    n = len(ring)
    b0 = P.vs(np.column_stack([ring, np.full(n, z0)]), M)
    b1 = P.vs(np.column_stack([ring, np.full(n, z1)]), M)
    h0 = P.vs(np.column_stack([hole, np.full(n, z0)]), M)
    h1 = P.vs(np.column_stack([hole, np.full(n, z1)]), M)
    for j in range(n):
        j2 = (j + 1) % n
        P.f((b0 + j, b0 + j2, b1 + j2, b1 + j), zone, group)
        P.f((h0 + j2, h0 + j, h1 + j, h1 + j2), zone, group)
        P.f((b1 + j, b1 + j2, h1 + j2, h1 + j), zone, group)
        P.f((b0 + j2, b0 + j, h0 + j, h0 + j2), zone, group)
