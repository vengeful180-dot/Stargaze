"""cabin_look.py - Cycles materials for every cabin zone, and the practical lights, by light group.

Imported by render_views.py (--lit) and bake_cabin.py. Materials read the mesh attributes the builder writes:
`zone` (picks the material slot), `part_seed` (per-part variation, so no two boards or cushions match).
Light groups: A = warm lamps (dimmable in game), B = console glow and accent strips (always on, gentle).
Metals use their F0 as base colour (skill rule 17); nothing darker than the audit's void floor.
"""
import math

import bpy

import node_expr

# zone -> (base linear rgb, roughness, metallic) for simple zones; procedural ones are built below
SIMPLE = {
    "default": ((0.5, 0.5, 0.5), 0.6, 0.0),
    "lining_dark": ((0.055, 0.047, 0.04), 0.6, 0.0),
    "leather": ((0.09, 0.045, 0.025), 0.45, 0.0),
    "ceramic": ((0.74, 0.70, 0.63), 0.18, 0.0),
    "ceramic_dark": ((0.035, 0.11, 0.13), 0.2, 0.0),
    "soil": ((0.05, 0.035, 0.025), 0.95, 0.0),
    "terracotta": ((0.42, 0.17, 0.085), 0.78, 0.0),
    "paper": ((0.7, 0.66, 0.56), 0.85, 0.0),
    "screen": ((0.012, 0.013, 0.015), 0.12, 0.0),
    "rubber": ((0.03, 0.03, 0.03), 0.8, 0.0),
    "metal_dark": ((0.14, 0.13, 0.12), 0.42, 1.0),
    "hidden": ((0.08, 0.07, 0.06), 0.8, 0.0),
    "tea": ((0.055, 0.022, 0.007), 0.04, 0.0),
    "enamel_red": ((0.40, 0.042, 0.028), 0.24, 0.0),
    "enamel_cream": ((0.60, 0.54, 0.42), 0.32, 0.0),
    "leaf_dark": ((0.028, 0.055, 0.018), 0.6, 0.0),
    "wire": ((0.03, 0.04, 0.025), 0.4, 0.0),
    "panel_teal": ((0.022, 0.068, 0.07), 0.36, 0.0),       # lacquered instrument panel
}

# emissive zones: (colour, strength, group). Strength is radiance in Blender units; the game reads it from the GLB
EMISSIVE = {
    "emit_warm": ((1.0, 0.68, 0.36), 60.0, "A"),
    "emit_strip": ((1.0, 0.62, 0.30), 9.0, "B"),
    "emit_screen": ((0.95, 0.62, 0.32), 2.2, "B"),
    "emit_orrery": ((1.0, 0.55, 0.25), 3.5, "B"),
}

WOOD = {
    # name: (dark, light, roughness, ring scale, figure)
    "walnut": ((0.10, 0.057, 0.032), (0.22, 0.13, 0.072), 0.38, 9.0, 0.9),
    "oak": ((0.30, 0.19, 0.10), (0.50, 0.35, 0.19), 0.42, 7.0, 0.7),
    "wall_wood": ((0.20, 0.115, 0.062), (0.36, 0.22, 0.12), 0.55, 7.0, 0.6),
    "wall_wood_b": ((0.20, 0.115, 0.062), (0.36, 0.22, 0.12), 0.55, 7.0, 0.6),
    "ceiling_wood": ((0.32, 0.22, 0.13), (0.48, 0.35, 0.22), 0.6, 6.0, 0.5),
    "floor_wood": ((0.10, 0.06, 0.035), (0.21, 0.13, 0.075), 0.45, 8.0, 0.8),
}

FABRIC = {
    "fabric_teal": (0.028, 0.105, 0.115),
    "fabric_mustard": (0.42, 0.25, 0.045),
    "fabric_rust": (0.28, 0.075, 0.035),
    "fabric_cream": (0.58, 0.51, 0.40),
}


def _bsdf(m):
    nt = m.node_tree
    b = nt.nodes.get("Principled BSDF")
    return nt, b


def make_simple(name, col, rough, metal):
    m = bpy.data.materials.new("M_" + name)
    nt, b = _bsdf(m)
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    return m


def make_wood(name, dark, light, rough, ring, figure, boards=None):
    """rift-sawn style grain along object X, per-part offset; optional board seams (axis, width) for panelling"""
    m = bpy.data.materials.new("M_" + name)
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    seed_vec, _ = g.attr("part_seed")
    seed = g.sep(seed_vec)[0]
    x, y, z = g.sep(co)
    # grain coordinate: mostly along x, waviness from low-frequency noise
    wav = g.noise(co, 1.6, 2.0, 0.5)
    r = g.add(g.add(g.mul(y, ring * 6.0), g.mul(z, ring * 3.0)), g.mul(wav, 2.2 + figure))
    r = g.add(r, g.mul(seed, 37.0))
    rings = g.mul(g.add(g.sin(r), 1.0), 0.5)
    fine = g.noise(g.comb(g.mul(x, 0.6), g.mul(y, 60.0), g.mul(z, 60.0)), 8.0, 3.0, 0.6)
    t = g.clamp01(g.add(g.mul(rings, 0.55), g.mul(fine, 0.45)))
    streak = g.noise(g.comb(g.mul(x, 0.25), g.add(g.mul(y, 3.0), seed), z), 2.0, 1.0, 0.5)
    t = g.clamp01(g.add(t, g.mul(g.sub(streak, 0.5), 0.6)))
    col = g.vlerp(dark, light, t)
    tone = g.add(0.88, g.mul(seed, 0.24))
    col = g.vscale(col, tone)
    if boards:
        axis, width = boards
        coord = {"x": x, "y": y, "z": z}[axis]
        q = g.div(coord, width)
        idx = g.floor(q)
        f = g.fract(q)
        seam = g.mul(g.smooth(0.0, 0.025, f), g.smooth(1.0, 0.975, f))
        board_tone = g.add(0.85, g.mul(g.white(g.comb(idx, seed, 3.7)), 0.3))
        col = g.vscale(col, g.mul(board_tone, g.add(0.55, g.mul(seam, 0.45))))
    nt.links.new(col, b.inputs["Base Color"])
    rr = g.add(rough, g.mul(g.sub(fine, 0.5), 0.12))
    nt.links.new(rr, b.inputs["Roughness"])
    bump = g.bump(g.mul(fine, 1.0), 0.06, 0.001)
    nt.links.new(bump, b.inputs["Normal"])
    return m


def make_fabric(name, col):
    m = bpy.data.materials.new("M_" + name)
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    seed_vec, _ = g.attr("part_seed")
    seed = g.sep(seed_vec)[0]
    x, y, z = g.sep(co)
    warp = g.mul(g.add(g.sin(g.mul(g.add(x, z), 1100.0)), 1.0), 0.5)
    weft = g.mul(g.add(g.sin(g.mul(g.add(y, z), 1100.0)), 1.0), 0.5)
    weave = g.add(0.85, g.mul(g.mul(warp, weft), 0.25))
    mott = g.add(0.9, g.mul(g.noise(co, 14.0, 3.0, 0.55), 0.2))
    tone = g.add(0.92, g.mul(seed, 0.16))
    c = g.vscale(col, g.mul(g.mul(weave, mott), tone))
    nt.links.new(c, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.92
    b.inputs["Sheen Weight"].default_value = 0.15
    nt.links.new(g.bump(g.mul(warp, weft), 0.12, 0.0005), b.inputs["Normal"])
    return m


def make_metal(name, f0, rough, rough_var=0.06):
    m = bpy.data.materials.new("M_" + name)
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    b.inputs["Base Color"].default_value = (*f0, 1)
    b.inputs["Metallic"].default_value = 1.0
    n = g.noise(co, 22.0, 3.0, 0.6)
    nt.links.new(g.add(rough, g.mul(g.sub(n, 0.5), rough_var)), b.inputs["Roughness"])
    # fine brushing
    x, y, z = g.sep(co)
    brush = g.noise(g.comb(g.mul(x, 2.0), g.mul(y, 400.0), g.mul(z, 400.0)), 3.0, 2.0, 0.5)
    nt.links.new(g.bump(brush, 0.04, 0.0002), b.inputs["Normal"])
    return m


def make_translucent(name, col, rough=0.8, translucency=0.45):
    """lamp shades and leaves: light passes through and they glow from behind"""
    m = bpy.data.materials.new("M_" + name)
    nt, b = _bsdf(m)
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Roughness"].default_value = rough
    trans = nt.nodes.new("ShaderNodeBsdfTranslucent")
    trans.inputs["Color"].default_value = (min(1, col[0] * 1.2), min(1, col[1] * 1.1), col[2], 1)
    mix = nt.nodes.new("ShaderNodeMixShader")
    mix.inputs[0].default_value = translucency
    out = nt.nodes.get("Material Output")
    nt.links.new(b.outputs[0], mix.inputs[1])
    nt.links.new(trans.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    m["base_color"] = col
    return m


def make_glass(name):
    m = bpy.data.materials.new("M_" + name)
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    glass = nt.nodes.new("ShaderNodeBsdfGlass")
    glass.inputs["IOR"].default_value = 1.18
    glass.inputs["Roughness"].default_value = 0.0
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    # light and bounces pass straight through; only camera rays see reflections (lookdev-rendering.md section 4)
    nt.links.new(lp.outputs["Is Camera Ray"], mix.inputs[0])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(glass.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    return m


def make_emissive(name, col, strength):
    m = bpy.data.materials.new("M_" + name)
    nt, b = _bsdf(m)
    b.inputs["Base Color"].default_value = (*col, 1)
    b.inputs["Emission Color"].default_value = (*col, 1)
    b.inputs["Emission Strength"].default_value = strength
    m["emit_strength"] = strength
    return m


def make_rug():
    m = bpy.data.materials.new("M_rug")
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    x, y, z = g.sep(co)
    r = g.sqrt(g.add(g.mul(x, x), g.mul(y, y)))
    band = g.fract(g.mul(r, 6.5))
    c1, c2, c3 = (0.30, 0.085, 0.04), (0.55, 0.47, 0.35), (0.04, 0.12, 0.13)
    t1 = g.smooth(0.3, 0.36, band)
    t2 = g.smooth(0.7, 0.76, band)
    col = g.vlerp(g.vlerp(c1, c2, t1), c3, g.mul(t2, g.smooth(0.3, 0.4, r)))
    mott = g.add(0.85, g.mul(g.noise(co, 30.0, 4.0, 0.6), 0.3))
    nt.links.new(g.vscale(col, mott), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.95
    return m


BOOK_PALETTE = [(0.30, 0.04, 0.03), (0.025, 0.04, 0.12), (0.035, 0.10, 0.05), (0.42, 0.26, 0.05),
                (0.14, 0.07, 0.035), (0.55, 0.48, 0.36), (0.025, 0.11, 0.12), (0.13, 0.035, 0.09)]


def make_book():
    """cloth bindings: each book (part_seed) picks a colour from a palette and a tone"""
    m = bpy.data.materials.new("M_book")
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    seed_vec, _ = g.attr("part_seed")
    seed = g.sep(seed_vec)[0]
    col = BOOK_PALETTE[0]
    for k in range(1, len(BOOK_PALETTE)):
        col = g.vlerp(col, BOOK_PALETTE[k], g.gt(seed, (k - 0.5) / len(BOOK_PALETTE)))
    tone = g.add(0.8, g.mul(g.fract(g.mul(seed, 13.7)), 0.35))
    co = g.texcoord("Object")
    cloth = g.add(0.9, g.mul(g.noise(co, 180.0, 2.0, 0.5), 0.2))
    nt.links.new(g.vscale(col, g.mul(tone, cloth)), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.62
    return m


def make_paint():
    """sage eggshell paint: a faint roller mottle, a fine orange-peel bump"""
    m = bpy.data.materials.new("M_wall_paint")
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    mott = g.add(0.95, g.mul(g.noise(co, 2.5, 3.0, 0.55), 0.1))
    nt.links.new(g.vscale((0.26, 0.30, 0.20), mott), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.72
    nt.links.new(g.bump(g.noise(co, 260.0, 2.0, 0.5), 0.05, 0.0005), b.inputs["Normal"])
    return m


def make_knit():
    """chunky oat knit: rows of V stitches (object space), soft and rough"""
    m = bpy.data.materials.new("M_knit")
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    x, y, z = g.sep(co)
    col_ = g.fract(g.mul(g.add(y, g.mul(x, 0.3)), 55.0))
    v = g.absf(g.sub(col_, 0.5))
    rows = g.fract(g.add(g.mul(g.add(z, g.mul(x, 0.7)), 75.0), g.mul(v, 1.6)))
    stitch = g.mul(g.smooth(0.0, 0.35, rows), g.smooth(1.0, 0.65, rows))
    h = g.mul(stitch, g.smooth(0.5, 0.2, v))
    tone = g.add(0.84, g.mul(h, 0.22))
    nt.links.new(g.vscale((0.52, 0.45, 0.34), tone), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.96
    b.inputs["Sheen Weight"].default_value = 0.35
    nt.links.new(g.bump(h, 0.45, 0.004), b.inputs["Normal"])
    return m


def make_gauge_face():
    """cream dial with ink ticks round the rim: 30 fine, 6 long (the face object sits in its gauge's frame: object
    z = the dial axis, so ticks are drawn about object x = y = 0)"""
    m = bpy.data.materials.new("M_gauge_face")
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    x, y, _ = g.sep(co)
    r = g.sqrt(g.add(g.mul(x, x), g.mul(y, y)))
    a = g.m("ARCTAN2", y, x)
    rim = g.mul(g.smooth(0.0245, 0.0255, r), g.smooth(0.031, 0.0298, r))
    long_rim = g.mul(g.smooth(0.0195, 0.0205, r), g.smooth(0.031, 0.0298, r))
    fine = g.smooth(0.47, 0.49, g.absf(g.sub(g.fract(g.mul(a, 30.0 / (2 * math.pi))), 0.5)))
    major = g.smooth(0.455, 0.47, g.absf(g.sub(g.fract(g.mul(a, 6.0 / (2 * math.pi))), 0.5)))
    ink = g.mx(g.mul(fine, rim), g.mul(major, long_rim))
    nt.links.new(g.vlerp((0.70, 0.64, 0.50), (0.03, 0.025, 0.02), ink), b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.5
    return m


def make_chart():
    """a star chart: navy paper, cream stars, gold declination circles and hour lines about its centre
    (the chart object sits in its frame's coordinates: object xy = the sheet)"""
    m = bpy.data.materials.new("M_chart")
    nt, b = _bsdf(m)
    g = node_expr.G(nt)
    co = g.texcoord("Object")
    x, y, _ = g.sep(co)
    yc = g.add(y, 0.04)
    r = g.sqrt(g.add(g.mul(x, x), g.mul(yc, yc)))
    rings = g.mul(g.smooth(0.46, 0.485, g.absf(g.sub(g.fract(g.div(r, 0.035)), 0.5))), g.smooth(0.17, 0.165, r))
    a = g.m("ARCTAN2", yc, x)
    hours = g.mul(g.smooth(0.475, 0.49, g.absf(g.sub(g.fract(g.mul(a, 12.0 / (2 * math.pi))), 0.5))), g.smooth(0.17, 0.165, r))
    edge = g.mul(g.smooth(0.168, 0.171, r), g.smooth(0.177, 0.174, r))
    gold = g.clamp01(g.add(g.add(g.mul(rings, 0.8), g.mul(hours, 0.6)), edge))
    cell = g.comb(g.floor(g.mul(x, 220.0)), g.floor(g.mul(y, 220.0)), 0.0)
    w = g.white(cell)
    stars = g.mul(g.smooth(0.965, 0.995, w), g.smooth(0.17, 0.16, r))
    col = g.vlerp((0.012, 0.02, 0.05), (0.5, 0.37, 0.14), gold)
    col = g.vlerp(col, (0.75, 0.70, 0.56), stars)
    nt.links.new(col, b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.7
    return m


_cache = {}


def material_for(zone):
    if zone in _cache:
        return _cache[zone]
    if zone in WOOD:
        dark, light, rough, ring, fig = WOOD[zone]
        # side-wall panelling: vertical boards (seams across y); back wall: vertical boards (seams across x);
        # ceiling and floor planks run fore and aft (seams across x)
        boards = {"wall_wood": ("y", 0.095), "wall_wood_b": ("x", 0.095), "ceiling_wood": ("x", 0.14),
                  "floor_wood": ("x", 0.15)}.get(zone)
        m = make_wood(zone, dark, light, rough, ring, fig, boards)
    elif zone in FABRIC:
        m = make_fabric(zone, FABRIC[zone])
    elif zone == "bronze":
        m = make_metal(zone, (0.42, 0.30, 0.20), 0.34)
    elif zone == "brass":
        m = make_metal(zone, (0.86, 0.68, 0.38), 0.26)
    elif zone == "glass":
        m = make_glass(zone)
    elif zone == "shade_fabric":
        m = make_translucent(zone, (0.72, 0.6, 0.44), 0.85, 0.55)
    elif zone == "plant":
        m = make_translucent(zone, (0.07, 0.21, 0.05), 0.45, 0.25)
    elif zone == "rug":
        m = make_rug()
    elif zone == "book":
        m = make_book()
    elif zone == "wall_paint":
        m = make_paint()
    elif zone == "knit":
        m = make_knit()
    elif zone == "gauge_face":
        m = make_gauge_face()
    elif zone == "chart":
        m = make_chart()
    elif zone in EMISSIVE:
        col, strength, _ = EMISSIVE[zone]
        m = make_emissive(zone, col, strength)
    else:
        col, rough, metal = SIMPLE.get(zone, SIMPLE["default"])
        m = make_simple(zone, col, rough, metal)
    m["zone"] = zone
    _cache[zone] = m
    return m


def apply_materials(objects, zones):
    """one material slot per zone used by each mesh, face material_index from the zone attribute"""
    import numpy as np
    for ob in objects:
        if ob.type != "MESH" or "zone" not in ob.data.attributes:
            continue
        me = ob.data
        zid = np.zeros(len(me.polygons), np.int32)
        me.attributes["zone"].data.foreach_get("value", zid)
        used = sorted(set(zid.tolist()))
        me.materials.clear()
        for z in used:
            me.materials.append(material_for(zones[z]))
        me.polygons.foreach_set("material_index", np.array([used.index(z) for z in zid], np.int32))


def kelvin_rgb(k):
    # warm practicals: a compact table is enough (linear rgb, max = 1)
    table = {2200: (1.0, 0.56, 0.22), 2400: (1.0, 0.6, 0.27), 2700: (1.0, 0.66, 0.36), 3000: (1.0, 0.71, 0.44)}
    return table[min(table, key=lambda t: abs(t - k))]


LIGHTS = [
    # practical lights inside the fittings. watts are radiant (Blender), solved from target irradiance on the
    # surfaces they light (see bake_cabin's per-object E report); each = one light per bulb of the host mesh
    {"name": "L_Pendant", "group": "A", "host": "Light_PendantBulb", "watts": 32.0, "radius": 0.03, "kelvin": 2400},
    {"name": "L_DeskLamp", "group": "A", "host": "Light_DeskLampBulb", "watts": 16.0, "radius": 0.022, "kelvin": 2700},
    {"name": "L_Sconce", "group": "A", "host": "Light_SconceBulb", "watts": 16.0, "radius": 0.018, "kelvin": 2400},
    {"name": "L_Fairy", "group": "A", "host": "Light_Fairy", "watts": 0.12, "radius": 0.006, "kelvin": 2200, "each": True},
    {"name": "L_StarJar", "group": "A", "host": "Light_StarJar", "watts": 0.04, "radius": 0.003, "kelvin": 2200, "each": True},
    {"name": "L_Galley", "group": "B", "host": "Light_GalleyStrip", "watts": 5.0, "kelvin": 2700, "kind": "AREA"},
    {"name": "L_Orrery", "group": "B", "host": "Light_OrrerySun", "watts": 0.25, "radius": 0.015, "kelvin": 2400},
]


def _components(ob):
    """world-space vertex sets of the connected pieces of a mesh (one bulb each)"""
    import numpy as np
    me = ob.data
    parent = list(range(len(me.vertices)))

    def find(a):
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    for e in me.edges:
        ra, rb = find(e.vertices[0]), find(e.vertices[1])
        if ra != rb:
            parent[rb] = ra
    groups = {}
    for v in me.vertices:
        groups.setdefault(find(v.index), []).append(ob.matrix_world @ v.co)
    return [np.array([p[:] for p in g]) for g in groups.values()]


def light_hosts():
    return [d["host"] for d in LIGHTS]


def add_lights(scene):
    """lights inside the practical fittings, one collection per group. The host bulb meshes are made invisible to
    shadow / diffuse / transmission rays: a point light inside a closed opaque bulb lit nothing (the first bakes'
    living area read E = 0)."""
    from mathutils import Vector
    colls = {}
    for g in ("A", "B"):
        c = bpy.data.collections.get("Lights_" + g) or bpy.data.collections.new("Lights_" + g)
        if c.name not in scene.collection.children:
            scene.collection.children.link(c)
        colls[g] = c
    made = []
    for d in LIGHTS:
        ob_host = bpy.data.objects.get(d["host"])
        if ob_host is None:
            raise RuntimeError(f"light {d['name']}: host {d['host']} missing")
        for attr in ("visible_shadow", "visible_diffuse", "visible_transmission", "visible_volume_scatter"):
            setattr(ob_host, attr, False)
        if d.get("kind") == "AREA":
            import numpy as np
            P = np.array([(ob_host.matrix_world @ v.co)[:] for v in ob_host.data.vertices])
            lo, hi = P.min(0), P.max(0)
            ld = bpy.data.lights.new(d["name"], "AREA")
            ld.shape = "RECTANGLE"
            ld.size, ld.size_y = float(hi[0] - lo[0]), float(hi[1] - lo[1])
            ld.energy = d["watts"]
            ld.color = kelvin_rgb(d["kelvin"])
            lo_ = bpy.data.objects.new(d["name"], ld)
            lo_.location = (float((lo[0] + hi[0]) / 2), float((lo[1] + hi[1]) / 2), float(lo[2] - 0.001))
            lo_["group"] = d["group"]
            colls[d["group"]].objects.link(lo_)
            made.append(lo_)
            continue
        centres = [c.mean(0) for c in _components(ob_host)] if d.get("each") else \
            [sum((ob_host.matrix_world @ Vector(c) for c in ob_host.bound_box), Vector()) / 8]
        for k, c in enumerate(centres):
            ld = bpy.data.lights.new(f"{d['name']}_{k}", "POINT")
            ld.energy = d["watts"]
            ld.shadow_soft_size = d["radius"]
            ld.color = kelvin_rgb(d["kelvin"])
            lo_ = bpy.data.objects.new(ld.name, ld)
            lo_.location = Vector(tuple(c))
            lo_["group"] = d["group"]
            colls[d["group"]].objects.link(lo_)
            made.append(lo_)
    return made


def set_group_visibility(groups_on):
    """lights and emissive meshes of groups not in groups_on contribute nothing (for per-group lightmap bakes)"""
    for ob in bpy.data.objects:
        if ob.type == "LIGHT" and "group" in ob:
            ob.hide_render = ob["group"] not in groups_on
    for zone, (col, strength, group) in EMISSIVE.items():
        m = _cache.get(zone)
        if m is None:
            continue
        b = m.node_tree.nodes.get("Principled BSDF")
        b.inputs["Emission Strength"].default_value = strength if group in groups_on else 0.0
