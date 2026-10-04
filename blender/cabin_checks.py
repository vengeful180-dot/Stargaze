"""cabin_checks.py - measured gates for the built cabin (skill: validation.md sections 5 and 7, hard-surface.md 1).

    blender -b --python-exit-code 1 -P blender/cabin_checks.py -- --blend blender/out/cabin_geo.blend
        [--report blender/out/checks.json] [--selftest]

closed       every mesh is closed and outward (no open edges, positive signed volume in world space)
attached     every connected piece reaches the hull through contacts: triangle overlap, one piece inside a closed
             other, or a gap <= TOL. Roots are the Shell_* pieces (floor, walls, lining). Anything else floats.
contained    no furniture or prop vertex beyond the lining's outer skin (the hull is not ours to pierce)
clearance    named pairs that must keep a gap (a bulb off its shade, plants off the glass, the rail off the portholes)
sweeps       moving parts through their whole range: orrery arms 360 deg against each other and the desk, the
             throttle and switches +-, gauge needles, radio knobs - no collision except with their own mount
eye          nothing within EYE_CLEAR of the pilot's eye

--selftest breaks the cabin on purpose (a mug lifted off the desk, a jar pushed into the wall, an orrery arm raised
into its neighbour's sweep, a part at the eye, a face deleted) and requires each break to add the failure it should.
Exit code 1 on any failure.
"""
import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict, deque

import bmesh
import bpy
import numpy as np
from mathutils import Matrix, Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cabin_layout as L  # noqa: E402

TOL = 0.0003                 # contact gap still counted as touching (below every intended gap; embeds are >= 0.4 mm)
EYE_CLEAR = 0.15
CONTAIN_MARGIN = 0.004       # stay this far inside the lining's outer skin
ENVELOPE = ("Shell_", "Frame_", "Glass_", "Porthole_")       # the hull itself: not subject to containment
T0 = time.time()


def log(*a):
    print(f"[{time.time() - T0:6.1f}s]", *a)
    sys.stdout.flush()


# ============================================================================================== geometry access
def world_mesh(ob):
    me = ob.data
    V = np.empty(len(me.vertices) * 3)
    me.vertices.foreach_get("co", V)
    V = V.reshape(-1, 3)
    M = np.array(ob.matrix_world)
    V = V @ M[:3, :3].T + M[:3, 3]
    F = [tuple(p.vertices) for p in me.polygons]
    return V, F


def split_components(V, F):
    parent = list(range(len(V)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for f in F:
        r0 = find(f[0])
        for v in f[1:]:
            r = find(v)
            if r != r0:
                parent[r] = r0
    groups = defaultdict(list)
    for fi, f in enumerate(F):
        groups[find(f[0])].append(fi)
    out = []
    for faces in groups.values():
        vids = sorted({v for fi in faces for v in F[fi]})
        remap = {v: i for i, v in enumerate(vids)}
        out.append((V[vids], [tuple(remap[v] for v in F[fi]) for fi in faces]))
    return out


class Piece:
    __slots__ = ("ob", "k", "V", "F", "lo", "hi", "tree")

    def __init__(self, ob, k, V, F):
        self.ob, self.k, self.V, self.F = ob, k, V, F
        self.lo, self.hi = V.min(0), V.max(0)
        self.tree = BVHTree.FromPolygons([Vector(v) for v in V], F, all_triangles=False, epsilon=0.0)

    @property
    def name(self):
        return f"{self.ob}#{self.k}"


def pieces_of(objs):
    out = []
    for ob in objs:
        V, F = world_mesh(ob)
        for k, (v, f) in enumerate(split_components(V, F)):
            out.append(Piece(ob.name, k, v, f))
    return out


def inside(p, tree, lo, hi):
    """point inside a closed mesh: ray parity along three skew directions, majority vote"""
    if np.any(p < lo) or np.any(p > hi):
        return False
    votes = 0
    for d in ((1.0, 0.0137, 0.0071), (-0.0113, 1.0, 0.0193), (0.0161, -0.0089, 1.0)):
        d = Vector(d).normalized()
        o = Vector(p)
        n = 0
        for _ in range(64):
            hit = tree.ray_cast(o, d)
            if hit[0] is None:
                break
            n += 1
            o = hit[0] + d * 1e-6
        votes += n % 2
    return votes >= 2


def min_gap(a, b, cap=0.05, sample=400):
    """smallest distance from a's vertices to b's surface and back (both ways: one-way misses a slab's flat
    underside - validation.md 5)"""
    best = cap
    for x, y in ((a, b), (b, a)):
        idx = np.linspace(0, len(x.V) - 1, min(sample, len(x.V))).astype(int)
        for p in x.V[idx]:
            hit = y.tree.find_nearest(Vector(p), best)
            if hit[0] is not None:
                best = min(best, hit[3])
    return best


def touching(a, b):
    if np.any(a.lo > b.hi + TOL) or np.any(b.lo > a.hi + TOL):
        return False
    if a.tree.overlap(b.tree):
        return True
    if inside(a.V[0], b.tree, b.lo, b.hi) or inside(b.V[0], a.tree, a.lo, a.hi):
        return True
    return min_gap(a, b, cap=TOL * 2, sample=200) <= TOL


def candidate_pairs(pcs, pad=TOL):
    lo = np.array([p.lo for p in pcs]) - pad
    hi = np.array([p.hi for p in pcs]) + pad
    order = np.argsort(lo[:, 0])
    out = []
    for ii, i in enumerate(order):
        for j in order[ii + 1:]:
            if lo[j, 0] > hi[i, 0]:
                break
            if np.all(lo[i] <= hi[j]) and np.all(lo[j] <= hi[i]):
                out.append((i, j))
    return out


# ============================================================================================== checks
def check_closed(objs):
    bad = []
    for ob in objs:
        bm = bmesh.new()
        bm.from_mesh(ob.data)
        bm.transform(ob.matrix_world)
        open_e = sum(1 for e in bm.edges if not e.is_manifold)
        vol = bm.calc_volume(signed=True)
        bm.free()
        if open_e or vol <= 0:
            bad.append(f"{ob.name}: {open_e} open edges, signed volume {vol:.3g}")
    return bad


def check_attached(pcs):
    adj = defaultdict(set)
    pairs = candidate_pairs(pcs)
    for i, j in pairs:
        if touching(pcs[i], pcs[j]):
            adj[i].add(j)
            adj[j].add(i)
    roots = [i for i, p in enumerate(pcs) if p.ob.startswith("Shell_")]
    seen = set(roots)
    dq = deque(roots)
    while dq:
        i = dq.popleft()
        for j in adj[i]:
            if j not in seen:
                seen.add(j)
                dq.append(j)
    loose = [i for i in range(len(pcs)) if i not in seen]
    bad = []
    by_ob = defaultdict(list)
    for i in loose:
        by_ob[pcs[i].ob].append(i)
    for ob, ids in sorted(by_ob.items()):
        p = pcs[ids[0]]
        near = min((min_gap(p, pcs[j], cap=0.2, sample=150) for j in seen if not np.any(pcs[j].lo > p.hi + 0.2)
                    and not np.any(p.lo > pcs[j].hi + 0.2)), default=0.2)
        bad.append(f"{ob}: {len(ids)} floating piece(s), {near * 1000:.1f} mm from the nearest attached part")
    return bad, {"pieces": len(pcs), "contacts": sum(len(v) for v in adj.values()) // 2, "pairs_tested": len(pairs)}


def hull_excess(P):
    """how far each point is beyond the hull's inner surface, as a fraction of the shell there (1 = outer skin)"""
    x, y, z = P[:, 0], P[:, 1], P[:, 2]
    e = (x / L.A) ** 2 + ((y - L.YJ) / L.CF) ** 2 + ((z - L.ZC) / L.B) ** 2
    g = 2 * np.sqrt((x / L.A ** 2) ** 2 + ((y - L.YJ) / L.CF ** 2) ** 2 + ((z - L.ZC) / L.B ** 2) ** 2)
    e2 = (x / L.A) ** 2 + ((z - L.ZC) / L.B) ** 2
    g2 = 2 * np.sqrt((x / L.A ** 2) ** 2 + ((z - L.ZC) / L.B ** 2) ** 2)
    d = np.where(y >= L.YJ, (e - 1) / np.maximum(g, 1e-9), (e2 - 1) / np.maximum(g2, 1e-9))
    return np.maximum.reduce([d / L.T_LINING, -z / L.FLOOR_T, (L.YB - y) / 0.06])


def check_contained(objs):
    bad = []
    worst = {}
    for ob in objs:
        if ob.name.startswith(ENVELOPE):
            continue
        V, _ = world_mesh(ob)
        ex = hull_excess(V)
        limit = 1.0 - CONTAIN_MARGIN / L.T_LINING
        worst[ob.name] = float(ex.max())
        n = int((ex > limit).sum())
        if n:
            p = V[int(ex.argmax())]
            bad.append(f"{ob.name}: {n} vertices beyond the lining's outer skin (worst {ex.max():.2f} of the shell at "
                       f"({p[0]:.3f}, {p[1]:.3f}, {p[2]:.3f}))")
    return bad, worst


def objs_named(objs, prefixes):
    return [o for o in objs if o.name.startswith(prefixes)]


CLEARANCES = [
    # (set A prefixes, set B prefixes, minimum gap m (0 = may not intersect), why)
    (("Trim_Dado",), ("Porthole_",), 0.01, "the dado rail runs under the portholes, never into their flanges"),
    (("Light_DeskLampBulb",), ("Lamp_DeskShade",), 0.02, "a bulb never touches its shade"),
    (("Light_PendantBulb",), ("Pendant_Shade",), 0.02, "a bulb never touches its shade"),
    (("Light_SconceBulb",), ("Sconce_Shade",), 0.01, "a bulb never touches its shade"),
    (("Plant_", "Telescope", "StarJar", "Deck_Book", "Fairy_Battery"), ("Glass_Canopy", "Frame_"), 0.0,
     "nothing on the deck pokes into the glass, the ribs or the sill"),
    (("Fairy_Wire", "Light_Fairy"), ("Glass_Canopy", "Frame_Mullion", "Frame_Arch_2", "Frame_Sill", "Plant_"), 0.0,
     "the fairy string hangs off its clips (on arch 1) and touches nothing else"),
    (("Seat_",), ("Console_",), 0.02, "the pilot seat stands clear of the console"),
    (("Plant_Hanging", "Hanger_Cords"), ("Nook_", "Sconce", "Trim_", "Shell_", "Frame_", "Light_Sconce"), 0.01,
     "the hanging plant hangs free (its ceiling plate is the only contact)"),
    (("Galley_Jar", "Galley_Tin", "Plant_Herb", "Galley_Kettle", "Galley_Mug_", "Galley_MugTree", "Back_Book_",
      "Plant_Bookcase"), ("Shell_", "Porthole_"), 0.004, "shelf and counter items stand off the curved wall"),
]


def check_clearance(objs, pcs_by_ob):
    """every object pair breaking a rule is reported (a rule's worst pair alone hid a second offender)"""
    bad = []
    info = []
    for A, B, gap, why in CLEARANCES:
        a_objs = [o for o in objs if o.name.startswith(A)]
        b_objs = [o for o in objs if o.name.startswith(B)]
        if not a_objs or not b_objs:
            bad.append(f"clearance '{why}': no objects match {A} / {B}")
            continue
        worst = 1.0
        n_bad = 0
        for ao in a_objs:
            for bo in b_objs:
                if ao.name == bo.name or (ao.name.startswith(B) and bo.name.startswith(A) and ao.name > bo.name):
                    continue
                d_pair = 1.0
                for pa in pcs_by_ob[ao.name]:
                    for pb in pcs_by_ob[bo.name]:
                        if np.any(pa.lo > pb.hi + gap + 0.01) or np.any(pb.lo > pa.hi + gap + 0.01):
                            continue
                        d = -1.0 if pa.tree.overlap(pb.tree) else min_gap(pa, pb, cap=max(gap, 0.001) + 0.01, sample=600)
                        d_pair = min(d_pair, d)
                worst = min(worst, d_pair)
                if (d_pair <= gap) if gap > 0 else (d_pair < 0):
                    n_bad += 1
                    bad.append(f"{ao.name} vs {bo.name}: {'INTERSECTS' if d_pair < 0 else f'gap {d_pair * 1000:.1f} mm'}"
                               f" (needs {gap * 1000:.0f} mm) - {why}")
        info.append({"why": why, "min_gap": round(worst, 4), "violations": n_bad})
    return bad, info


def rot_about(M, axis, ang):
    """world matrix of an object whose rest matrix is M, turned by ang about its own local axis"""
    if axis == "z":
        R = Matrix.Rotation(ang, 4, "Z")
    else:
        R = Matrix.Rotation(ang, 4, "X")
    return M @ R


SWEEPS = [
    # (moving object prefix, local axis, angles deg, mounts it may touch)
    ("Orrery_Arm_", "z", np.arange(0, 360, 6), ("Orrery_Base", "Orrery_Arm_")),
    ("Throttle_Lever", "x", np.arange(-25, 26, 5), ("Throttle_Base",)),
    ("Switch_", "x", np.arange(-35, 36, 7), ("Switch_Plate",)),
    ("Gauge_1_Needle", "z", np.arange(-120, 121, 12), ("Gauge_1",)),
    ("Gauge_2_Needle", "z", np.arange(-120, 121, 12), ("Gauge_2",)),
    ("Radio_Knob_", "z", np.arange(0, 360, 12), ("Radio_Body", "Radio_Knob_")),
]


def check_sweeps(objs, pcs):
    bad = []
    info = []
    static_tree = {}
    for mover_prefix, axis, angles, mounts in SWEEPS:
        movers = [o for o in objs if o.name.startswith(mover_prefix) and o.get("pivot")]
        if not movers:
            bad.append(f"sweep {mover_prefix}: no pivoted objects")
            continue
        for mv in movers:
            Vloc = np.array([v.co[:] for v in mv.data.vertices])
            F = [tuple(p.vertices) for p in mv.data.polygons]
            M0 = mv.matrix_world.copy()
            hits = []
            # what it could reach anywhere in its sweep: bounding sphere about the pivot
            piv = np.array(M0.translation)
            rad = np.linalg.norm(Vloc, axis=1).max()
            near = [p for p in pcs if p.ob != mv.name and not p.ob.startswith(mounts)
                    and np.all(p.lo <= piv + rad) and np.all(p.hi >= piv - rad)]
            for ang in angles:
                M = np.array(rot_about(M0, axis, math.radians(float(ang))))
                Vw = Vloc @ M[:3, :3].T + M[:3, 3]
                tree = BVHTree.FromPolygons([Vector(v) for v in Vw], F)
                lo, hi = Vw.min(0), Vw.max(0)
                for p in near:
                    if np.any(p.lo > hi) or np.any(lo > p.hi):
                        continue
                    if tree.overlap(p.tree):
                        hits.append((float(ang), p.ob))
            # movers of the same family against each other: every relative angle
            if mover_prefix == "Orrery_Arm_":
                for other in movers:
                    if other.name <= mv.name:
                        continue
                    Vo = np.array([v.co[:] for v in other.data.vertices])
                    Fo = [tuple(p.vertices) for p in other.data.polygons]
                    Mo = np.array(other.matrix_world)
                    to = BVHTree.FromPolygons([Vector(v) for v in Vo @ Mo[:3, :3].T + Mo[:3, 3]], Fo)
                    for ang in angles:
                        M = np.array(rot_about(M0, axis, math.radians(float(ang))))
                        tree = BVHTree.FromPolygons([Vector(v) for v in Vloc @ M[:3, :3].T + M[:3, 3]], F)
                        if tree.overlap(to):
                            hits.append((float(ang), other.name))
            info.append({"mover": mv.name, "angles": len(angles), "hits": len(hits)})
            if hits:
                obs = sorted({h[1] for h in hits})
                bad.append(f"{mv.name} sweeping about local {axis}: hits {', '.join(obs[:4])}"
                           f"{' ...' if len(obs) > 4 else ''} at {len(hits)} angle(s), first {hits[0][0]:.0f} deg")
    return bad, info


def check_eye(pcs):
    eye = Vector(L.EYE)
    best = 9.0
    who = None
    for p in pcs:
        hit = p.tree.find_nearest(eye, best)
        if hit[0] is not None and hit[3] < best:
            best, who = hit[3], p.ob
    bad = [f"{who} is {best * 100:.1f} cm from the pilot's eye (< {EYE_CLEAR * 100:.0f} cm)"] if best < EYE_CLEAR else []
    return bad, {"nearest": who, "dist": round(best, 3)}


def run_all(tag=""):
    objs = [o for o in bpy.data.objects if o.type == "MESH"]
    out = {}
    fails = []
    b = check_closed(objs)
    out["closed"] = {"fail": b}
    fails += [("closed", x) for x in b]
    log(f"{tag}closed: {len(objs)} meshes, {len(b)} bad")
    pcs = pieces_of(objs)
    pcs_by_ob = defaultdict(list)
    for p in pcs:
        pcs_by_ob[p.ob].append(p)
    b, info = check_attached(pcs)
    out["attached"] = {"fail": b, **info}
    fails += [("attached", x) for x in b]
    log(f"{tag}attached: {info['pieces']} pieces, {info['contacts']} contacts of {info['pairs_tested']} pairs, {len(b)} bad")
    b, worst = check_contained(objs)
    out["contained"] = {"fail": b, "worst": sorted(worst.items(), key=lambda kv: -kv[1])[:8]}
    fails += [("contained", x) for x in b]
    log(f"{tag}contained: {len(worst)} parts, {len(b)} bad; deepest {out['contained']['worst'][:3]}")
    b, info = check_clearance(objs, pcs_by_ob)
    out["clearance"] = {"fail": b, "pairs": info}
    fails += [("clearance", x) for x in b]
    log(f"{tag}clearance: {len(info)} rules, {len(b)} bad")
    b, info = check_sweeps(objs, pcs)
    out["sweeps"] = {"fail": b, "movers": info}
    fails += [("sweeps", x) for x in b]
    log(f"{tag}sweeps: {len(info)} movers, {len(b)} bad")
    b, info = check_eye(pcs)
    out["eye"] = {"fail": b, **info}
    fails += [("eye", x) for x in b]
    log(f"{tag}eye: nearest {info['nearest']} at {info['dist']} m")
    return fails, out


# ============================================================================================== self-test
def move(name, d):
    ob = bpy.data.objects[name]
    ob.matrix_world = Matrix.Translation(Vector(d)) @ ob.matrix_world


BREAKS = [
    # (description, action, check that must gain a failure, object name that must appear in it)
    ("mug lifted 4 mm off the desk (2 mm sink + 2 mm gap)", lambda: (move("Mug", (0, 0, 0.004)), move("Mug_Tea", (0, 0, 0.004))),
     "attached", "Mug"),
    ("jar pushed 6 cm into the wall", lambda: move("Galley_Jar_1", (0.06, 0, 0)), "clearance", "Galley_Jar_1"),
    ("deck plant pot pushed out through the glass", lambda: move("Plant_DeckR_Pot", (0.3, 0.25, 0.0)), "contained",
     "Plant_DeckR_Pot"),
    ("orrery arm 2 raised into arm 1's level", lambda: move("Orrery_Arm_2", (0, 0, 0.028)), "sweeps", "Orrery_Arm_"),
    ("throttle lever pushed down into the desk", lambda: move("Throttle_Lever", (0, 0, -0.03)), "sweeps", "Throttle_Lever"),
    ("pendant bulb raised against its shade", lambda: move("Light_PendantBulb", (0.17, 0, 0.01)), "clearance", "Pendant"),
    ("a book at the pilot's eye", lambda: move("Logbook", (0.0 - bpy.data.objects["Logbook"].matrix_world.translation.x,
                                                          L.EYE[1] - 0.73, L.EYE[2] - L.DESK_Z - 0.05)), "eye", "Logbook"),
    ("a face deleted from the radio body", lambda: delete_face("Radio_Body"), "closed", "Radio_Body"),
]


def delete_face(name):
    me = bpy.data.objects[name].data
    bm = bmesh.new()
    bm.from_mesh(me)
    bm.faces.ensure_lookup_table()
    bm.faces.remove(bm.faces[len(bm.faces) // 2])
    bm.to_mesh(me)
    bm.free()


def selftest(blend):
    base, _ = run_all("[base] ")
    base_set = set(base)
    results = []
    ok = True
    for desc, act, check, who in BREAKS:
        bpy.ops.wm.open_mainfile(filepath=blend)
        act()
        bpy.context.view_layer.update()
        fails, _ = run_all(f"[{desc[:18]}] ")
        new = [f for f in fails if f not in base_set and f[0] == check and who in f[1]]
        results.append({"break": desc, "caught": bool(new), "by": new[:2]})
        log(f"SELFTEST {'caught' if new else 'MISSED'}: {desc} -> {new[:1]}")
        ok &= bool(new)
    return ok, results


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", required=True)
    ap.add_argument("--report")
    ap.add_argument("--selftest", action="store_true")
    a = ap.parse_args(argv)
    blend = os.path.abspath(a.blend)
    bpy.ops.wm.open_mainfile(filepath=blend)
    report = {}
    if a.selftest:
        ok, res = selftest(blend)
        report["selftest"] = res
        if not ok:
            if a.report:
                json.dump(report, open(a.report, "w"), indent=1)
            raise RuntimeError("self-test: a break was not caught - the checks cannot be trusted")
        bpy.ops.wm.open_mainfile(filepath=blend)
    fails, out = run_all()
    report.update(out)
    if a.report:
        json.dump(report, open(a.report, "w"), indent=1, default=str)
    for c, f in fails:
        print(f"FAIL {c}: {f}")
    if fails:
        raise RuntimeError(f"{len(fails)} cabin check failure(s)")
    print("CHECKS OK")


main()
