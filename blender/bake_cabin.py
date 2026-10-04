"""bake_cabin.py - atlas UVs, texture + lightmap bakes, reflection probe and the web GLB for the cabin.

    blender -b --python-exit-code 1 -P blender/bake_cabin.py -- --blend blender/out/cabin_geo.blend \
        --out public/assets/cabin [--tex 2048] [--lm 1024] [--lm-samples 64] [--quick]

Skill references: texturing-baking.md (packing margin in texels, push-pull fill, AO normalised to the visible
surface, metals' F0 through emission), lookdev-rendering.md section 4 (light from believable sources).

Outputs in --out:
  cabin.glb             geometry + UVs only (materials are named placeholders; the game builds its own)
  albedo.png            sRGB base colour (metals: F0)
  orm.png               R ambient occlusion, G roughness, B metallic
  normal.png            tangent-space normal (the materials' bump detail)
  lm_a.png, lm_b.png    lightmaps of light group A (lamps) and B (console glow): irradiance / pi, stored as
                        sqrt(E / LM_SCALE) in 8 bits (finer steps in the dark, where cozy lighting lives)
  probe.png             equirectangular view from the pilot's eye, both groups on (reflections), same encoding
  cabin.json            manifest: files, encodings, light groups, emissive strengths, markers
"""
import json
import math
import os
import sys
import time

import bmesh
import bpy
import numpy as np
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cabin_layout as L  # noqa: E402
import cabin_look as LOOK  # noqa: E402
from build_cabin_zones import ZONES  # noqa: E402

ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(n, d=None):
    return ARGS[ARGS.index(n) + 1] if n in ARGS else d


OUT = os.path.abspath(arg("--out", "public/assets/cabin"))
TEX = int(arg("--tex", "2048"))
LM = int(arg("--lm", "1024"))
LM_SAMPLES = int(arg("--lm-samples", "64"))
QUICK = "--quick" in ARGS
LM_SCALE = 8.0          # lightmap stores sqrt(E / LM_SCALE): E up to 8 (the desk under the lamp reaches ~3)
T0 = time.time()

EMISSIVE_PREFIX = ("Light_",)
GLASS_NAMES = ("Glass_Canopy",)
SCREEN_NAMES = ("Screen_L", "Screen_C", "Screen_R", "Radio_Dial")
SHADES = ("Lamp_DeskShade", "Pendant_Shade", "Sconce_Shade")


def log(*a):
    print(f"[{time.time() - T0:7.1f}s]", *a)
    sys.stdout.flush()


def select(objs, active=None):
    for o in bpy.context.view_layer.objects:
        o.select_set(o in objs)
    bpy.context.view_layer.objects.active = active or (objs[0] if objs else None)


def classify():
    atlas, glass, emissive, screens, shades = [], [], [], [], []
    for o in bpy.data.objects:
        if o.type != "MESH":
            continue
        n = o.name
        if n in GLASS_NAMES or n.endswith("_Glass"):
            glass.append(o)
        elif n.startswith(EMISSIVE_PREFIX):
            emissive.append(o)
        elif n in SCREEN_NAMES:
            screens.append(o)
        elif n in SHADES:
            shades.append(o)
            atlas.append(o)
        else:
            atlas.append(o)
    return atlas, glass, emissive, screens, shades


# ============================================================================================== visibility
def viewpoints():
    """places a person can put their eyes in the cabin (seated, standing, nook, galley, near the door)"""
    pts = [L.EYE, (0, -0.4, 1.6), (0, -1.5, 1.65), (-0.7, -1.4, 1.05), (0.65, -1.3, 1.55), (0, -2.1, 1.6),
           (0.6, 0.1, 1.2), (-0.6, 0.1, 1.2), (0, 0.4, 0.5), (0, -1.0, 0.6), (-0.5, -2.2, 1.2), (0.5, -2.2, 1.2),
           (0, 0.6, 1.0), (0.9, 0.5, 1.1), (-0.9, 0.5, 1.1), (-1.0, -1.45, 1.1), (0.55, -1.6, 1.6), (0, -0.75, 1.65),
           (0.3, 0.75, 1.15), (-0.3, 0.75, 1.15), (0.0, -1.9, 0.9)]
    return [Vector(p) for p in pts]


def hidden_faces(objs):
    """faces no viewpoint can see (backs of panels, buried bases, undersides): their islands get 1/8 scale"""
    verts, polys, owner = [], [], []
    for o in objs:
        mw = o.matrix_world
        base = len(verts)
        verts.extend(mw @ v.co for v in o.data.vertices)
        for p in o.data.polygons:
            polys.append([base + i for i in p.vertices])
            owner.append((o.name, p.index))
    tree = BVHTree.FromPolygons(verts, polys)
    eyes = viewpoints()
    out = {o.name: [] for o in objs}
    fi = 0
    for o in objs:
        mw = o.matrix_world
        nm = mw.to_3x3().inverted().transposed()
        co = [v.co for v in o.data.vertices]
        for p in o.data.polygons:
            n = (nm @ p.normal).normalized()
            vs = list(p.vertices)
            samples = [mw @ p.center] + [mw @ (p.center.lerp(co[vs[k]], 0.8)) for k in range(0, len(vs), max(1, len(vs) // 3))]
            seen = False
            for c in samples:
                c = c + n * 1e-4
                for e in eyes:
                    d = c - e
                    if d.dot(n) >= -1e-6:        # facing away from this eye
                        continue
                    dist = d.length
                    hit = tree.ray_cast(e, d / dist, dist - 5e-4)
                    if hit[0] is None or hit[2] == fi:
                        seen = True
                        break
                if seen:
                    break
            if not seen:
                out[o.name].append(p.index)
            fi += 1
    return out


# ============================================================================================== UVs
SOLID = ("Fairy_Wire", "StarJar_Wire", "Hanger_Cords", "Pendant_Cord", "Lamp_Harp", "Fairy_Clips", "Radio_Aerial",
         "Telescope_Mount", "Radio_Feet", "Radio_Knob_", "Switch_1", "Switch_2", "Switch_3", "Switch_4", "Gauge_1_Needle",
         "Gauge_2_Needle", "Pencil", "Orrery_Arm_", "Back_Book_", "Deck_Book_",
         "Galley_Jar_", "Galley_Tin_", "Galley_Mug_", "Back_Hooks", "Hanger_Hook", "Door_Wheel", "Nook_Book",
         "Galley_MugTree", "Sconce", "StarJar_Lid", "Pendant_Cap", "Pendant_Rose", "Fairy_Battery",
         "Door_WindowFrame")       # + every part under SMALL_M2 (big panels in cells looked faceted)
SMALL_M2 = 0.006                                    # visible area under which a part gets flat cells, not islands
PLANAR = ("Plant_",)                                # leafy parts: one top-down island per plant
SPLIT_FILL = 0.6                                    # islands filling less of their box than this are cut up
VIS_MAX = 0.961                                     # visible islands live in [0, VIS_MAX]^2
SOLID_ROWS = (0.9625, 0.967, 0.9715, 0.976)         # flat cells above them; hidden faces share the far corner
CELL = 0.0045
SLIVER_M2 = 0.0004                                  # islands smaller than this (rims, bevels) go to flat cells too


def unwrap(objs, hid):
    """Islands cost a packing margin each: 6,000 of them (a leaf, a knob, every side of a book) shrank the atlas to
    3 % coverage. So: smart project (66 deg) for the big surfaces, one top-down island per plant, and flat cells -
    one per (part, material zone) - for thin and small parts; pack only the visible islands, then collapse hidden
    faces into the corner cell."""
    for o in objs:
        me = o.data
        uv = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
        me.uv_layers.active = uv
        uv.active_render = True
    select(objs)
    bpy.ops.object.mode_set(mode="OBJECT")

    def vis_area(o):
        hs = set(hid[o.name])
        return sum(p.area for p in o.data.polygons if p.index not in hs)

    planar = [o for o in objs if o.name.startswith(PLANAR) and o.name.endswith("_Leaves")]
    solid = [o for o in objs if o not in planar and (o.name.startswith(SOLID) or vis_area(o) < SMALL_M2)]
    regular = [o for o in objs if o not in solid and o not in planar]

    def select_faces(which):
        """exactly the visible faces of `which` (edit mode, face flags): setting polygon.select in object mode
        left every vertex of a fresh mesh selected, edit mode flushed that back to ALL faces, and 47,000 hidden
        faces were unwrapped and packed with the visible ones - the atlas came out 3 % full"""
        bpy.context.tool_settings.mesh_select_mode = (False, False, True)
        for o in objs:
            hs = set(hid[o.name])
            bm = bmesh.from_edit_mesh(o.data)
            for v in bm.verts:
                v.select = False
            for e in bm.edges:
                e.select = False
            for f in bm.faces:
                f.select = False
            if o in which:
                for f in bm.faces:
                    if f.index not in hs:
                        f.select_set(True)
            bm.select_mode = {"FACE"}
            bmesh.update_edit_mesh(o.data)

    zones = {}                                      # face zones, read before edit mode hides the attribute
    for o in objs:
        z = np.zeros(len(o.data.polygons), np.int32)
        o.data.attributes["zone"].data.foreach_get("value", z)
        zones[o.name] = z
    cells = {}                                      # (part, zone) -> flat cell index
    for o in solid:
        for zz in sorted(set(zones[o.name].tolist())):
            cells[(o.name, zz)] = len(cells)
    flat_faces = {o.name: set() for o in objs}     # slivers of regular parts that go to their part's flat cells
    def density(parts):
        a3 = auv = 0.0
        for o in parts:
            bm = bmesh.from_edit_mesh(o.data)
            lay = bm.loops.layers.uv["UVMap"]
            for f in bm.faces:
                if f.select:
                    a3 += f.calc_area()
                    uvs = [lp[lay].uv for lp in f.loops]
                    auv += 0.5 * abs(sum(uvs[i].x * uvs[(i + 1) % len(uvs)].y - uvs[(i + 1) % len(uvs)].x * uvs[i].y
                                         for i in range(len(uvs))))
        return math.sqrt(auv / max(a3, 1e-12))

    bpy.ops.object.mode_set(mode="EDIT")
    select_faces(set(regular))
    bpy.ops.uv.smart_project(angle_limit=math.radians(66.0), island_margin=0.0, area_weight=0.0, correct_aspect=True,
                             scale_to_bounds=False)
    k = density(regular)
    for o in planar:
        bm = bmesh.from_edit_mesh(o.data)
        lay = bm.loops.layers.uv["UVMap"]
        hs = set(hid[o.name])
        M = o.matrix_world
        for f in bm.faces:
            if f.index in hs:
                continue
            for lp in f.loops:
                w = M @ lp.vert.co
                lp[lay].uv = (w.x * k * 1.3, w.y * k * 1.3)       # top-down: leaves face up; stems collapse
            f.select_set(True)
        bmesh.update_edit_mesh(o.data)
    # slivers: UV islands of regular parts under SLIVER_M2 leave the packing for flat cells
    n_sliver = n_split = 0
    for o in regular:
        bm = bmesh.from_edit_mesh(o.data)
        lay = bm.loops.layers.uv["UVMap"]
        bm.faces.ensure_lookup_table()
        sel = [f for f in bm.faces if f.select]
        key = {}
        parent = {f.index: f.index for f in sel}

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for f in sel:
            for lp in f.loops:
                kk = (lp.vert.index, round(lp[lay].uv.x, 6), round(lp[lay].uv.y, 6))
                if kk in key:
                    ra, rb = find(key[kk]), find(f.index)
                    if ra != rb:
                        parent[rb] = ra
                else:
                    key[kk] = f.index
        isl = {}
        for f in sel:
            isl.setdefault(find(f.index), []).append(f)
        for faces in isl.values():
            if sum(f.calc_area() for f in faces) < SLIVER_M2:
                for f in faces:
                    f.select = False
                    flat_faces[o.name].add(f.index)
                    zz = int(zones[o.name][f.index])
                    if (o.name, zz) not in cells:
                        cells[(o.name, zz)] = len(cells)
                n_sliver += 1
                continue
            # a flat arc (a rib's side, the sill, a porthole ring, the desk's C) cannot be split by angle: its
            # bounding box wasted most of the atlas. Cut it into angular sectors round its box centre.
            uvs = np.array([[lp[lay].uv.x, lp[lay].uv.y] for f in faces for lp in f.loops])
            lo, hi = uvs.min(0), uvs.max(0)
            box = float(np.prod(np.maximum(hi - lo, 1e-9)))
            area = sum(0.5 * abs(sum(f.loops[i][lay].uv.x * f.loops[(i + 1) % len(f.loops)][lay].uv.y
                                     - f.loops[(i + 1) % len(f.loops)][lay].uv.x * f.loops[i][lay].uv.y
                                     for i in range(len(f.loops)))) for f in faces)
            fill = area / box
            if fill < SPLIT_FILL and len(faces) > 8:
                kk_ = min(24, int(math.ceil(SPLIT_FILL / max(fill, 1e-3) * 1.5)))
                c = (lo + hi) / 2
                for f in faces:
                    fc = np.mean([[lp[lay].uv.x, lp[lay].uv.y] for lp in f.loops], 0)
                    sec = int((math.atan2(fc[1] - c[1], fc[0] - c[0]) + math.pi) / (2 * math.pi) * kk_) % kk_
                    for lp in f.loops:                # a tiny shift disconnects the sector (no tile change)
                        lp[lay].uv.x += 1e-4 * (sec + 1)
                n_split += 1
        bmesh.update_edit_mesh(o.data)
    log(f"unwrap: {len(regular)} parts smart projected (density {k:.3f}), {len(planar)} plants top-down, "
        f"{len(solid)} parts in flat cells, {n_sliver} sliver islands flattened, {n_split} thin arcs cut, "
        f"{len(cells)} cells")
    # hero surfaces near the pilot get more texels: scale their islands up before packing
    for o in regular + planar:
        boost = 1.0
        if o.name.startswith(("Gauge_1_Face", "Gauge_2_Face")):
            boost = 6.0                              # ticks on a 67 mm dial must survive the atlas
        elif o.name == "Back_Chart":
            boost = 2.5                              # stars and circles on the chart
        elif o.name.startswith(("Console_", "Seat_", "Radio_", "Lamp_", "Orrery_", "Mug", "Screen_", "Logbook", "Throttle_",
                                "Switch_", "Gauge_", "Telescope", "StarJar", "Deck_Book")):
            boost = 1.6
        elif o.name.startswith(("Frame_", "Plant_", "Galley_", "Nook_", "Back_", "Sconce", "Pendant_", "Door_")):
            boost = 1.2
        if boost != 1.0:
            bm = bmesh.from_edit_mesh(o.data)
            lay = bm.loops.layers.uv["UVMap"]
            for f in bm.faces:
                if f.select:
                    for lp in f.loops:
                        lp[lay].uv = lp[lay].uv * boost
            bmesh.update_edit_mesh(o.data)
    # everything into the unit square first: pack_islands packs each island into the UDIM tile CLOSEST to where it
    # lies, and the boosted / planar islands that had wandered past u = 1 were packed into tiles the bake never sees
    # (the "3 % coverage" atlases)
    lo = np.array([1e9, 1e9])
    hi = -lo
    for o in regular + planar:
        bm = bmesh.from_edit_mesh(o.data)
        lay = bm.loops.layers.uv["UVMap"]
        for f in bm.faces:
            if f.select:
                for lp in f.loops:
                    lo = np.minimum(lo, (lp[lay].uv.x, lp[lay].uv.y))
                    hi = np.maximum(hi, (lp[lay].uv.x, lp[lay].uv.y))
    span = float(max(hi - lo)) * 1.001
    for o in regular + planar:
        bm = bmesh.from_edit_mesh(o.data)
        lay = bm.loops.layers.uv["UVMap"]
        for f in bm.faces:
            if f.select:
                for lp in f.loops:
                    lp[lay].uv = ((lp[lay].uv.x - lo[0]) / span, (lp[lay].uv.y - lo[1]) / span)
        bmesh.update_edit_mesh(o.data)
    margin = 4.0 / min(TEX, LM * 2)                 # 2 lightmap texels, 4 atlas texels
    pack_islands_skyline(regular + planar, margin, VIS_MAX, whole=planar)
    # visible islands shrink into [0, VIS_MAX]; flat cells in the rows above; hidden faces in the corner
    per_row = int(0.98 / CELL)
    if len(cells) > len(SOLID_ROWS) * per_row:
        raise RuntimeError(f"{len(cells)} flat cells do not fit {len(SOLID_ROWS)} rows of {per_row}")
    for o in objs:
        bm = bmesh.from_edit_mesh(o.data)
        lay = bm.loops.layers.uv["UVMap"]
        hs = set(hid[o.name])
        bm.faces.ensure_lookup_table()
        is_solid = o in solid
        fl = flat_faces[o.name]
        zs = zones[o.name]
        for f in bm.faces:
            if f.index in hs:
                for kk, lp in enumerate(f.loops):
                    lp[lay].uv = (0.9825 + 0.006 * (kk % 2), 0.9825 + 0.006 * ((kk // 2) % 2))
            elif is_solid or f.index in fl:
                ci = cells[(o.name, int(zs[f.index]))]
                u0 = (ci % per_row) * CELL + 0.001
                v0 = SOLID_ROWS[ci // per_row] + 0.001
                CELL_RECTS.append((u0, v0, 0.0025))
                for kk, lp in enumerate(f.loops):
                    lp[lay].uv = (u0 + 0.0025 * (kk % 2), v0 + 0.0025 * ((kk // 2) % 2))
        bmesh.update_edit_mesh(o.data)
    bpy.ops.object.mode_set(mode="OBJECT")
    return solid


FLAT = set()                                        # parts unwrapped to flat cells (no density to measure)
CELL_RECTS = []                                     # (u0, v0, size) of every flat cell, for averaging after bakes


def flatten_cells(arr):
    """one value per flat cell: its faces overlap there, the bake wrote a different face into each texel and the
    parts showed every face's own light (faceted galley doors)"""
    res = arr.shape[0]
    for u0, v0, sz in CELL_RECTS:
        x0, y0 = int(u0 * res), int(v0 * res)
        x1, y1 = max(x0 + 1, int(math.ceil((u0 + sz) * res))), max(y0 + 1, int(math.ceil((v0 + sz) * res)))
        block = arr[y0:y1, x0:x1]
        block[...] = block.reshape(-1, *arr.shape[2:]).mean(0)
    return arr


def _hull(pts):
    pts = np.unique(np.round(pts, 9), axis=0)
    if len(pts) < 3:
        return pts
    pts = pts[np.lexsort((pts[:, 1], pts[:, 0]))]

    def half(ps):
        h = []
        for p in ps:
            while len(h) >= 2 and ((h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0])) <= 0:
                h.pop()
            h.append(p)
        return h

    lower, upper = half(pts), half(pts[::-1])
    return np.array(lower[:-1] + upper[:-1])


def _min_rect_angle(pts):
    """rotation that puts the island's minimum-area bounding rectangle on the axes, wider than tall"""
    h = _hull(pts)
    best = (float("inf"), 0.0)
    if len(h) >= 3:
        for i in range(len(h)):
            e = h[(i + 1) % len(h)] - h[i]
            a = -math.atan2(e[1], e[0])
            c, s_ = math.cos(a), math.sin(a)
            r = h @ np.array([[c, s_], [-s_, c]])
            ext = r.max(0) - r.min(0)
            if ext[0] * ext[1] < best[0]:
                best = (ext[0] * ext[1], a + (math.pi / 2 if ext[1] > ext[0] else 0.0))
    return best[1]


def skyline_pack(sizes, side, margin):
    """bottom-left skyline packing of rectangles (w, h) into a side x side square; positions or None if they do
    not fit. Rectangles are placed in the given order."""
    sky = [(0.0, 0.0, side)]                         # (x, y, width) segments, left to right
    out = []
    for w, h in sizes:
        w2, h2 = w + margin, h + margin
        best = None
        for i in range(len(sky)):
            x = sky[i][0]
            if x + w2 > side + 1e-12:
                break
            # the rectangle rests on the highest segment it spans
            y, j, span = 0.0, i, 0.0
            while span < w2 - 1e-12 and j < len(sky):
                y = max(y, sky[j][1])
                span += sky[j][2]
                j += 1
            if span < w2 - 1e-12 or y + h2 > side + 1e-12:
                continue
            if best is None or y + h2 < best[1] + best[3] - 1e-12 or (abs(y + h2 - best[1] - best[3]) < 1e-12 and x < best[0]):
                best = (x, y, i, h2)
        if best is None:
            return None
        x, y, i, _ = best
        out.append((x, y))
        # raise the skyline under the new rectangle
        new, cut = [], x + w2
        for (sx, sy, sw) in sky:
            ex = sx + sw
            if ex <= x + 1e-12 or sx >= cut - 1e-12:
                new.append((sx, sy, sw))
                continue
            if sx < x:
                new.append((sx, sy, x - sx))
            if ex > cut:
                new.append((cut, sy, ex - cut))
        new.append((x, y + h2, w2))
        new.sort()
        merged = []
        for seg in new:
            if merged and abs(merged[-1][1] - seg[1]) < 1e-12 and abs(merged[-1][0] + merged[-1][2] - seg[0]) < 1e-9:
                merged[-1] = (merged[-1][0], merged[-1][1], merged[-1][2] + seg[2])
            else:
                merged.append(seg)
        sky = merged
    return out


def pack_islands_skyline(objs, margin, side, whole=()):
    """Blender's pack left most of the square empty round these islands (the "3-17 % coverage" atlases): this one
    turns every island to its minimum-area rectangle and skyline-packs them, searching the largest common scale."""
    islands = []                                     # (object, face indices, rotation, rotated bbox)
    bms = {}
    for o in objs:
        bm = bmesh.from_edit_mesh(o.data)
        bm.faces.ensure_lookup_table()
        bms[o.name] = bm
        lay = bm.loops.layers.uv["UVMap"]
        sel = [f for f in bm.faces if f.select]
        parent = {f.index: f.index for f in sel}

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        key = {}
        for f in sel:
            for lp in f.loops:
                kk = (lp.vert.index, round(lp[lay].uv.x, 7), round(lp[lay].uv.y, 7))
                if kk in key:
                    ra, rb = find(key[kk]), find(f.index)
                    if ra != rb:
                        parent[rb] = ra
                else:
                    key[kk] = f.index
        groups = {}
        for f in sel:
            groups.setdefault(0 if o in whole else find(f.index), []).append(f)
        for faces in groups.values():
            pts = np.array([[lp[lay].uv.x, lp[lay].uv.y] for f in faces for lp in f.loops])
            a = _min_rect_angle(pts)
            c, s_ = math.cos(a), math.sin(a)
            R = np.array([[c, -s_], [s_, c]])
            r = pts @ R.T
            lo, hi = r.min(0), r.max(0)
            islands.append({"o": o, "faces": [f.index for f in faces], "R": R, "lo": lo, "size": hi - lo})
    order = sorted(range(len(islands)), key=lambda i: -islands[i]["size"][1])
    big = sorted(islands, key=lambda d: -float(max(d["size"])))[:5]
    log("largest islands: " + ", ".join(f"{d['o'].name} {d['size'][0]:.3f}x{d['size'][1]:.3f} ({len(d['faces'])} faces)" for d in big))
    sizes = np.array([islands[i]["size"] for i in order])
    f_lo, f_hi = 0.0, side / max(1e-9, float(sizes.max()))
    best = None
    for _ in range(26):
        f = 0.5 * (f_lo + f_hi)
        pos = skyline_pack([(w * f, h * f) for w, h in sizes], side, margin)
        if pos is None:
            f_hi = f
        else:
            f_lo, best = f, (f, pos)
    f, pos = best
    for k, i in enumerate(order):
        isl = islands[i]
        bm = bms[isl["o"].name]
        lay = bm.loops.layers.uv["UVMap"]
        x0, y0 = pos[k]
        for fi in isl["faces"]:
            for lp in bm.faces[fi].loops:
                r = isl["R"] @ np.array([lp[lay].uv.x, lp[lay].uv.y])
                lp[lay].uv = (x0 + margin / 2 + (r[0] - isl["lo"][0]) * f, y0 + margin / 2 + (r[1] - isl["lo"][1]) * f)
    for o in objs:
        bmesh.update_edit_mesh(o.data)
    used = float(sum(w * h for w, h in sizes) * f * f / (side * side))
    log(f"skyline pack: {len(islands)} islands, scale {f:.3f}, boxes fill {used:.1%} of the square")
    return f


def uv_stats(objs, hid, res):
    a3 = auv = 0.0
    for o in objs:
        me = o.data
        me.calc_loop_triangles()
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers["UVMap"].uv.foreach_get("vector", uv)
        uv = uv.reshape(-1, 2)
        P = np.empty(len(me.vertices) * 3)
        me.vertices.foreach_get("co", P)
        P = P.reshape(-1, 3)
        if o.name in FLAT:
            continue
        hs = set(hid.get(o.name, []))
        tris = [t for t in me.loop_triangles if t.polygon_index not in hs]
        if not tris:
            continue
        lt = np.array([t.loops[:] for t in tris])
        vt = np.array([t.vertices[:] for t in tris])
        a, b, c = P[vt[:, 0]], P[vt[:, 1]], P[vt[:, 2]]
        a3 += 0.5 * np.linalg.norm(np.cross(b - a, c - a), axis=1).sum()
        ua, ub, uc = uv[lt[:, 0]], uv[lt[:, 1]], uv[lt[:, 2]]
        auv += 0.5 * np.abs((ub[:, 0] - ua[:, 0]) * (uc[:, 1] - ua[:, 1]) - (uc[:, 0] - ua[:, 0]) * (ub[:, 1] - ua[:, 1])).sum()
    dens = res * math.sqrt(auv / max(a3, 1e-9))
    log(f"UV: {a3:.1f} m2 visible, coverage {auv:.1%}, {dens:.0f} px/m at {res}")
    if not QUICK and (auv < 0.30 or dens < 80):
        raise RuntimeError(f"UV guard: coverage {auv:.1%} / {dens:.0f} px/m below 30 % / 80 px/m - fix the packing")
    return {"visible_m2": round(float(a3), 2), "coverage": round(float(auv), 4), "px_per_m": round(float(dens), 1)}


def screen_uvs(screens):
    """0..1 UVs over each screen's front face (the game draws a canvas there); other faces collapse to a corner"""
    for o in screens:
        me = o.data
        uv = me.uv_layers.get("UVMap") or me.uv_layers.new(name="UVMap")
        # front face: the one whose normal points most toward the pilot (local +z of the screen frame)
        best = max(me.polygons, key=lambda p: (o.matrix_world.to_3x3() @ p.normal).dot(Vector(L.EYE) - o.matrix_world @ p.center))
        n = best.normal
        ax = Vector((1, 0, 0)) if abs(n.x) < 0.9 else Vector((0, 1, 0))
        u_ax = ax.cross(n).normalized()
        v_ax = n.cross(u_ax).normalized()
        co = [v.co for v in me.vertices]
        us = [co[i].dot(u_ax) for i in best.vertices]
        vs = [co[i].dot(v_ax) for i in best.vertices]
        u0, u1, v0, v1 = min(us), max(us), min(vs), max(vs)
        for p in me.polygons:
            for li in p.loop_indices:
                vi = me.loops[li].vertex_index
                if p.index == best.index:
                    uv.data[li].uv = ((co[vi].dot(u_ax) - u0) / (u1 - u0), (co[vi].dot(v_ax) - v0) / (v1 - v0))
                else:
                    uv.data[li].uv = (0.0, 0.0)


# ============================================================================================== bake plumbing
def route(mat, channel):
    """send one channel of a material to an Emission shader on the output (None restores the original surface)"""
    nt = mat.node_tree
    out = next(n for n in nt.nodes if n.type == "OUTPUT_MATERIAL")
    if "orig_surface" not in mat:
        link = out.inputs["Surface"].links[0] if out.inputs["Surface"].links else None
        mat["orig_surface"] = link.from_node.name if link else ""
        mat["orig_socket"] = link.from_socket.name if link else ""
    em = nt.nodes.get("BakeEmit") or nt.nodes.new("ShaderNodeEmission")
    em.name = "BakeEmit"
    em.inputs["Strength"].default_value = 1.0
    for l in list(em.inputs["Color"].links):
        nt.links.remove(l)
    if channel is None:
        src = nt.nodes.get(mat["orig_surface"])
        if src is not None:
            nt.links.new(src.outputs[mat["orig_socket"]], out.inputs["Surface"])
        return
    b = nt.nodes.get("Principled BSDF")
    if channel == "base":
        if "base_color" in mat and b is not None and not b.inputs["Base Color"].links:
            em.inputs["Color"].default_value = (*mat["base_color"], 1)
        elif b is not None:
            s = b.inputs["Base Color"]
            if s.links:
                nt.links.new(s.links[0].from_socket, em.inputs["Color"])
            else:
                em.inputs["Color"].default_value = s.default_value
        else:
            em.inputs["Color"].default_value = (0.5, 0.5, 0.5, 1)
    elif channel == "metal":
        v = 0.0
        if b is not None:
            s = b.inputs["Metallic"]
            if s.links:
                nt.links.new(s.links[0].from_socket, em.inputs["Color"])
                v = None
            else:
                v = s.default_value
        if v is not None:
            em.inputs["Color"].default_value = (v, v, v, 1)
    elif channel == "white":
        em.inputs["Color"].default_value = (1, 1, 1, 1)
    nt.links.new(em.outputs[0], out.inputs["Surface"])


def materials_of(objs):
    ms = []
    for o in objs:
        for s in o.material_slots:
            if s.material and s.material not in ms:
                ms.append(s.material)
    return ms


def bake(objs, kind, res, samples, channel=None, pass_filter=None):
    sc = bpy.context.scene
    img = bpy.data.images.new(f"bake_{channel or kind}", res, res, alpha=False, float_buffer=True)
    img.colorspace_settings.name = "Non-Color"
    mats = materials_of(objs)
    for m in mats:
        nt = m.node_tree
        t = nt.nodes.get("BakeTarget") or nt.nodes.new("ShaderNodeTexImage")
        t.name = "BakeTarget"
        t.image = img
        uvn = nt.nodes.get("BakeUV") or nt.nodes.new("ShaderNodeUVMap")
        uvn.name = "BakeUV"
        uvn.uv_map = "UVMap"
        nt.links.new(uvn.outputs["UV"], t.inputs["Vector"])
        nt.nodes.active = t
        if channel:
            route(m, channel)
    sc.cycles.samples = samples
    rb = sc.render.bake
    rb.target = "IMAGE_TEXTURES"
    rb.margin = 0 if channel == "white" else 3
    rb.margin_type = "EXTEND"
    if pass_filter is not None:
        rb.use_pass_direct = "DIRECT" in pass_filter
        rb.use_pass_indirect = "INDIRECT" in pass_filter
        rb.use_pass_color = "COLOR" in pass_filter
    select(objs)
    t = time.time()
    bpy.ops.object.bake(type=kind, use_clear=True, margin=rb.margin, normal_space="TANGENT")
    px = np.empty(res * res * 4, np.float32)
    img.pixels.foreach_get(px)
    log(f"bake {channel or kind} @ {res}: {time.time() - t:.0f}s")
    if channel:
        for m in mats:
            route(m, None)
    bpy.data.images.remove(img)
    return px.reshape(res, res, 4)[:, :, :3].copy()


def fill_background(arr, covered):
    a = arr.astype(np.float32)
    a = a if a.ndim == 3 else a[..., None]
    w = covered.astype(np.float32)[..., None]
    levels = [(a * w, w)]
    while min(levels[-1][0].shape[:2]) > 1:
        s, c = levels[-1]
        h2, w2 = s.shape[0] // 2, s.shape[1] // 2
        levels.append((s[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, -1).sum((1, 3)),
                       c[:h2 * 2, :w2 * 2].reshape(h2, 2, w2, 2, -1).sum((1, 3))))
    s, c = levels[-1]
    val = s / np.maximum(c, 1e-8)
    for s, c in reversed(levels[:-1]):
        up = np.repeat(np.repeat(val, 2, 0), 2, 1)
        up = np.pad(up, ((0, s.shape[0] - up.shape[0]), (0, s.shape[1] - up.shape[1]), (0, 0)), mode="edge")
        val = np.where(c > 0, s / np.maximum(c, 1e-8), up)
    return val if arr.ndim == 3 else val[..., 0]


def downsample(a, res):
    f = a.shape[0] // res
    if f <= 1:
        return a
    return a.reshape(res, f, res, f, *a.shape[2:]).mean((1, 3))


def denoise(arr):
    """OpenImageDenoise through the compositor (Blender 5.2: compositing_node_group with a Group Output)"""
    sc = bpy.context.scene
    h, w = arr.shape[:2]
    src = bpy.data.images.new("dn_src", w, h, alpha=False, float_buffer=True)
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = arr
    src.pixels.foreach_set(rgba.ravel())
    tree = bpy.data.node_groups.new("DenoiseTree", "CompositorNodeTree")
    tree.interface.new_socket("Image", in_out="OUTPUT", socket_type="NodeSocketColor")
    n_img = tree.nodes.new("CompositorNodeImage")
    n_img.image = src
    n_dn = tree.nodes.new("CompositorNodeDenoise")
    n_out = tree.nodes.new("NodeGroupOutput")
    tree.links.new(n_img.outputs["Image"], n_dn.inputs["Image"])
    tree.links.new(n_dn.outputs["Image"], n_out.inputs[0])
    try:
        n_dn.inputs["HDR"].default_value = True
    except Exception:  # noqa: BLE001
        pass
    prev = sc.compositing_node_group
    sc.compositing_node_group = tree
    sc.render.use_compositing = True
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = w, h, 100
    # render nothing: a camera looking at an empty layer; the compositor provides the image
    vl = sc.view_layers[0]
    hide = [o for o in sc.objects if not o.hide_render]
    for o in hide:
        o.hide_render = True
    sc.render.engine = "CYCLES"
    sc.cycles.samples = 1
    path = os.path.join(OUT, "_dn.exr")
    sc.render.image_settings.file_format = "OPEN_EXR"
    sc.render.image_settings.color_depth = "32"
    sc.render.filepath = path
    if sc.camera is None:
        cam = bpy.data.objects.new("DnCam", bpy.data.cameras.new("DnCam"))
        sc.collection.objects.link(cam)
        sc.camera = cam
    bpy.ops.render.render(write_still=True)
    for o in hide:
        o.hide_render = False
    sc.compositing_node_group = prev
    out = bpy.data.images.load(path)
    px = np.empty(w * h * 4, np.float32)
    out.pixels.foreach_get(px)
    bpy.data.images.remove(out)
    bpy.data.images.remove(src)
    os.remove(path)
    del vl
    return px.reshape(h, w, 4)[..., :3]


def save_png(arr, path, encode):
    a = np.clip(arr, 0.0, None).astype(np.float32)
    if encode == "srgb":
        a = np.clip(a, 0, 1)
        a = np.where(a <= 0.0031308, 12.92 * a, 1.055 * np.power(a, 1 / 2.4) - 0.055)
    elif encode == "lm":
        a = np.sqrt(np.clip(a / LM_SCALE, 0, 1))
    else:
        a = np.clip(a, 0, 1)
    h, w = a.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=False, float_buffer=False)
    img.colorspace_settings.name = "Non-Color"
    rgba = np.ones((h, w, 4), np.float32)
    rgba[..., :3] = a if a.ndim == 3 else a[..., None]
    img.pixels.foreach_set(rgba.ravel())
    img.filepath_raw = path
    img.file_format = "PNG"
    img.save()
    bpy.data.images.remove(img)
    log("wrote", os.path.relpath(path))


# ============================================================================================== main steps
def bake_textures(atlas):
    tex = {}
    mask = bake(atlas, "EMIT", TEX, 1, channel="white")[:, :, 0] > 0.5
    log(f"atlas coverage mask {mask.mean():.1%}")
    tex["base"] = bake(atlas, "EMIT", TEX, 4, channel="base")
    tex["metal"] = bake(atlas, "EMIT", TEX, 1, channel="metal")[:, :, 0]
    tex["rough"] = bake(atlas, "ROUGHNESS", TEX, 4)[:, :, 0]
    tex["normal"] = bake(atlas, "NORMAL", TEX, 4)
    bpy.context.scene.world.light_settings.distance = 0.5
    ao = bake(atlas, "AO", TEX, 16 if QUICK else 48)[:, :, 0]
    med = float(np.median(ao[mask])) if mask.any() else 1.0
    tex["ao"] = np.clip(ao / max(med, 1e-3), 0, 1) ** 0.8
    for k in tex:
        tex[k] = flatten_cells(fill_background(tex[k], mask))
    clear = (tex["base"].max(2) < 1e-6) & (tex["rough"] < 1e-6)
    if clear.mean() > 0.002:
        raise RuntimeError(f"fill failed: {clear.mean():.2%} texels hold the clear value")
    save_png(tex["base"], os.path.join(OUT, "albedo.png"), "srgb")
    save_png(np.stack([tex["ao"], tex["rough"], tex["metal"]], 2), os.path.join(OUT, "orm.png"), "data")
    save_png(tex["normal"], os.path.join(OUT, "normal.png"), "data")
    stats = {"coverage_mask": float(mask.mean()), "albedo_p50": float(np.median(tex["base"][mask].mean(1)))}
    return mask, stats


def object_irradiance(atlas, e):
    """area-weighted irradiance per object over its visible faces (face UV centres sampled in the lightmap): mean
    and 90th percentile. A plain median over faces was ruled by small edge faces (a counter read 0.06)."""
    res = e.shape[0]
    lum = e.mean(2)
    out = {}
    for o in atlas:
        me = o.data
        uv = np.empty(len(me.loops) * 2, np.float32)
        me.uv_layers["UVMap"].uv.foreach_get("vector", uv)
        uv = uv.reshape(-1, 2)
        vals, wts = [], []
        for p in me.polygons:
            c = uv[p.loop_start:p.loop_start + p.loop_total].mean(0)
            if c[0] > 0.975 and c[1] > 0.975:          # hidden faces share the corner cell
                continue
            x = min(res - 1, max(0, int(c[0] * res)))
            y = min(res - 1, max(0, int(c[1] * res)))
            vals.append(lum[y, x])
            wts.append(p.area)
        if vals:
            v, w = np.array(vals), np.array(wts)
            order = np.argsort(v)
            cw = np.cumsum(w[order]) / w.sum()
            out[o.name] = (float((v * w).sum() / w.sum()), float(v[order][np.searchsorted(cw, 0.9)]))
    return out


def bake_proxy(atlas):
    """Cycles bakes object by object with a per-object cost: 208 parts took 135 s for a 1-sample emission pass.
    The parts whose materials do not read object space are joined into one proxy for the bakes (the originals hide
    from render so nothing is in the scene twice); pivoted parts (charts, dials, moving parts) stay separate."""
    keep = [o for o in atlas if o.get("pivot")]
    join = [o for o in atlas if not o.get("pivot")]
    dups = []
    for o in join:
        d = o.copy()
        d.data = o.data.copy()
        bpy.context.scene.collection.objects.link(d)
        dups.append(d)
        o.hide_render = True
    select(dups, dups[0])
    bpy.ops.object.join()
    proxy = bpy.context.view_layer.objects.active
    proxy.name = "BakeProxy"
    log(f"bake proxy: {len(join)} parts joined, {len(keep)} kept apart")
    return proxy, [proxy] + keep, join


def drop_proxy(proxy, originals):
    me = proxy.data
    bpy.data.objects.remove(proxy)
    bpy.data.meshes.remove(me)
    for o in originals:
        o.hide_render = False


def bake_lightmaps(atlas, mask_hi, report_objs=None):
    mask = downsample(mask_hi.astype(np.float32), LM) > 0.25
    out = {}
    report = {}
    for g in ("A", "B"):
        LOOK.set_group_visibility({g})
        lm = bake(atlas, "DIFFUSE", LM, LM_SAMPLES, pass_filter={"DIRECT", "INDIRECT"})
        e = lm * math.pi                     # irradiance; the game shades with albedo * E / pi
        e = fill_background(e, mask)
        try:
            e = np.maximum(denoise(e), 0.0)
            log(f"denoised lightmap {g}")
        except Exception as ex:  # noqa: BLE001
            log(f"denoise unavailable ({ex}); keeping the raw bake")
        e = flatten_cells(e)
        out[g] = e
        p = np.percentile(e[mask].mean(1), [5, 50, 95, 99.5])
        log(f"lightmap {g}: E p5 {p[0]:.4f} p50 {p[1]:.4f} p95 {p[2]:.3f} p99.5 {p[3]:.3f} (clips above {LM_SCALE})")
        save_png(e, os.path.join(OUT, f"lm_{g.lower()}.png"), "lm")
        per = object_irradiance(report_objs or atlas, e)
        report[g] = {k: [round(v[0], 4), round(v[1], 4)] for k, v in per.items()}
        key = ["Rug", "Shell_Floor", "Console_Desk", "Console_Pad", "Nook_Cushion", "Galley_Top", "Shell_Lining",
               "Shell_Back", "Back_Bookcase", "Seat_Cushion", "Console_Binnacle", "Console_Deck", "Frame_Arch_1",
               "Radio_Body", "Lamp_Desk", "Orrery_Base", "Galley_Cabinet", "Nook_Bench", "Shell_Chin"]
        log(f"lightmap {g} E mean/p90: " + ", ".join(f"{k} {per[k][0]:.2f}/{per[k][1]:.2f}" for k in key if k in per))
    LOOK.set_group_visibility({"A", "B"})
    return out, report


def render_probe():
    sc = bpy.context.scene
    cam = bpy.data.objects.new("ProbeCam", bpy.data.cameras.new("ProbeCam"))
    sc.collection.objects.link(cam)
    cam.data.type = "PANO"
    cam.data.panorama_type = "EQUIRECTANGULAR"
    cam.location = L.EYE
    cam.rotation_euler = (math.pi / 2, 0, -math.pi / 2)        # three.js equirect: centre column = -Z (Blender +Y)
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = 512 if QUICK else 1024, 256 if QUICK else 512, 100
    sc.cycles.samples = 32 if QUICK else 96
    sc.cycles.use_denoising = True
    sc.render.image_settings.file_format = "OPEN_EXR"
    sc.render.image_settings.color_depth = "32"
    path = os.path.join(OUT, "_probe.exr")
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    img = bpy.data.images.load(path)
    w, h = img.size
    px = np.empty(w * h * 4, np.float32)
    img.pixels.foreach_get(px)
    bpy.data.images.remove(img)
    os.remove(path)
    save_png(px.reshape(h, w, 4)[..., :3], os.path.join(OUT, "probe.png"), "lm")


PIVOT_AXES = {"Orrery_Arm_": "y", "Radio_Knob_": "y", "Gauge_1_Needle": "y", "Gauge_2_Needle": "y",
              "Throttle_Lever": "x", "Switch_": "x"}      # three.js local axis (Blender local z -> glTF y)


def gltf_vec(v):
    """Blender Z-up -> glTF Y-up"""
    return [round(float(v[0]), 5), round(float(v[2]), 5), round(float(-v[1]), 5)]


def export_glb(atlas, glass, emissive, screens, shades):
    """one static mesh for everything in the atlas except named interactive parts; glass, emitters and screens as
    their own nodes. Placeholder materials carry names the game keys on. Returns manifest sections."""
    sc = bpy.context.scene
    keep_separate = ("Radio_Knob_", "Radio_Body", "Orrery_Arm_", "Throttle_Lever", "Switch_1", "Switch_2", "Switch_3",
                     "Switch_4", "Gauge_1_Needle", "Gauge_2_Needle", "Mug", "Lamp_Desk", "Telescope") + SHADES
    coll = bpy.data.collections.new("Export")
    sc.collection.children.link(coll)
    mats = {k: bpy.data.materials.new(k) for k in ("CabinAtlas", "Glass", "Emit_A", "Emit_B", "Screen", "Shade")}
    for m in mats.values():
        m.use_backface_culling = True
    # the sources give up their names first: a copy named while its source existed became "Screen_C.001" and the
    # game found no screens
    for o in [o for o in bpy.data.objects if o.type == "MESH"]:
        o.name = "SRC_" + o.name

    def copy(o, mat):
        c = o.copy()
        c.data = o.data.copy()
        c.data.materials.clear()
        c.data.materials.append(mat)
        for p in c.data.polygons:
            p.material_index = 0
        for a in list(c.data.attributes):
            if a.name in ("zone", "lgroup", "part_seed"):
                c.data.attributes.remove(a)
        coll.objects.link(c)
        c.name = o.name.removeprefix("SRC_")
        if c.name != o.name.removeprefix("SRC_"):
            raise RuntimeError(f"export name clash: {o.name} -> {c.name}")
        return c

    static, nodes = [], []
    for o in atlas:
        base = o.name.removeprefix("SRC_")
        c = copy(o, mats["Shade"] if base in SHADES else mats["CabinAtlas"])
        (nodes if base.startswith(keep_separate) else static).append(c)
    select(static, static[0])
    bpy.ops.object.join()
    body = bpy.context.view_layer.objects.active
    body.name = "Cabin_Static"
    for o in glass:
        nodes.append(copy(o, mats["Glass"]))
    emitters = {}
    for o in emissive:
        g = np.zeros(len(o.data.polygons), np.int32)
        o.data.attributes["lgroup"].data.foreach_get("value", g)
        z = np.zeros(len(o.data.polygons), np.int32)
        o.data.attributes["zone"].data.foreach_get("value", z)
        zone = ZONES[int(np.bincount(z).argmax())]
        grp = "A" if (g == 1).sum() >= (g == 2).sum() else "B"
        c = copy(o, mats["Emit_" + grp])
        col, strength, _ = LOOK.EMISSIVE[zone]
        emitters[c.name] = {"group": grp, "zone": zone, "color": list(col), "strength": strength}
        nodes.append(c)
    for o in screens:
        nodes.append(copy(o, mats["Screen"]))
    pivots = {}
    for c in nodes:
        for pre, ax in PIVOT_AXES.items():
            if c.name.startswith(pre):
                pivots[c.name] = ax
    # markers
    for name, loc in (("Spot_Pilot", L.EYE), ("Spot_Nook", (-0.75, -1.45, 1.05)), ("Spot_Galley", (0.62, -1.25, 1.55))):
        e = bpy.data.objects.new(name, None)
        e.location = loc
        coll.objects.link(e)
    for o in list(sc.objects):
        o.select_set(o.users_collection[0] == coll if o.users_collection else False)
    path = os.path.join(OUT, "cabin.glb")
    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB", use_selection=True, export_apply=True,
                              export_extras=True, export_materials="EXPORT", export_image_format="NONE",
                              export_attributes=False)
    log("wrote", os.path.relpath(path), f"{os.path.getsize(path) / 1e6:.1f} MB")
    # the radio: where the music comes from (its front faces the pilot: -y of its desk frame)
    rb = bpy.data.objects["Radio_Body"]
    P = np.array([(rb.matrix_world @ v.co)[:] for v in rb.data.vertices])
    centre = (P.min(0) + P.max(0)) / 2
    phi = math.atan2(centre[0], centre[1])
    facing = (-math.sin(phi), -math.cos(phi), 0.0)
    return {"emitters": emitters, "pivots": pivots,
            "radio": {"pos": gltf_vec(centre), "facing": gltf_vec(facing)},
            "nodes": sorted(c.name for c in nodes)}


def main():
    blend = arg("--blend", "blender/out/cabin_geo.blend")
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(blend))
    os.makedirs(OUT, exist_ok=True)
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.max_bounces = 6
    sc.cycles.diffuse_bounces = 4
    sc.cycles.glossy_bounces = 2
    sc.cycles.transmission_bounces = 4
    sc.cycles.transparent_max_bounces = 8
    sc.world = sc.world or bpy.data.worlds.new("W")
    bg = sc.world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0, 0, 0, 1)
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    LOOK.apply_materials(meshes, ZONES)
    LOOK.add_lights(sc)
    atlas, glass, emissive, screens, shades = classify()
    log(f"{len(atlas)} atlas parts, {len(glass)} glass, {len(emissive)} emitters, {len(screens)} screens")
    hid = hidden_faces(atlas)
    n_h = sum(len(v) for v in hid.values())
    log(f"hidden faces: {n_h} of {sum(len(o.data.polygons) for o in atlas)}")
    FLAT.update(o.name for o in unwrap(atlas, hid))
    st = uv_stats(atlas, hid, TEX)
    screen_uvs(screens)
    proxy, bake_set, originals = bake_proxy(atlas)
    mask, tstats = bake_textures(bake_set)
    lms, lm_report = bake_lightmaps(bake_set, mask, report_objs=atlas)
    drop_proxy(proxy, originals)
    render_probe()
    exp = export_glb(atlas, glass, emissive, screens, shades)
    manifest = {
        "glb": "cabin.glb",
        "textures": {"albedo": "albedo.png", "orm": "orm.png", "normal": "normal.png", "lm_a": "lm_a.png",
                     "lm_b": "lm_b.png", "probe": "probe.png"},
        "lightmap": {"encoding": "sqrt(E / scale)", "scale": LM_SCALE, "res": LM},
        "emissive": {z: {"color": c, "strength": s, "group": g} for z, (c, s, g) in LOOK.EMISSIVE.items()},
        "lights": [{"name": d["name"], "group": d["group"], "watts": d["watts"]} for d in LOOK.LIGHTS],
        "emitters": exp["emitters"],
        "pivots": exp["pivots"],
        "radio": exp["radio"],
        "nodes": exp["nodes"],
        "lightmap_E": lm_report,
        "uv": st,
        "bake": {k: (float(v) if isinstance(v, (np.floating, float)) else v) for k, v in tstats.items()},
        "tex": TEX,
    }
    json.dump(manifest, open(os.path.join(OUT, "cabin.json"), "w"), indent=1)
    log("BAKE DONE")


main()
