"""render_views.py - clay / preview renders of the cabin from the game's spots and a cutaway overview.

    blender -b --python-exit-code 1 -P blender/render_views.py -- --blend blender/out/cabin_geo.blend --out shots/cabin
        [--views eye,up,left,right,back,top,side] [--engine EEVEE|CYCLES] [--res 960x540] [--samples 32] [--lit]

Clay = one grey material on everything but glass (rule: never judge geometry through a finished material).
Every view checks its subject is in frame: a grid of camera rays must hit cabin geometry.
"""
import argparse
import math
import os
import sys

import bpy
import numpy as np
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cabin_layout as L  # noqa: E402
import cabin_look as LOOK  # noqa: E402

DEG = math.pi / 180

VIEWS = {
    # name: (location, (yaw deg, pitch deg) from forward +Y, lens mm) - eye views match the game's seated head
    "eye": (L.EYE, (0, -4), 18.5),
    "up": (L.EYE, (0, 62), 18.5),
    "left": (L.EYE, (-75, -6), 18.5),
    "right": (L.EYE, (75, -6), 18.5),
    "back": (L.EYE, (180, -8), 18.5),
    "nook": ((-0.75, -1.45, 1.05), (90, -6), 18.5),
    "galley": ((0.7, -1.3, 1.45), (-110, -10), 18.5),
    "door": ((0.0, 0.3, 1.5), (180, -10), 18.5),
    "top": ((0.0, -0.5, 7.0), (90, -89.9), 50.0),
    "side": ((5.5, -0.5, 1.2), (-90, 0), 26.0),
}


def look(cam, loc, yaw, pitch):
    cam.location = loc
    # Blender camera looks down -Z; start pointing at +Y (rot x 90), then yaw about Z (bearing: + to starboard)
    cam.rotation_euler = (math.radians(90 + pitch), 0.0, math.radians(-yaw))


def clay_material():
    m = bpy.data.materials.new("Clay")
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (0.62, 0.6, 0.57, 1)
    b.inputs["Roughness"].default_value = 0.7
    g = bpy.data.materials.new("ClayGlass")
    gb = g.node_tree.nodes["Principled BSDF"]
    gb.inputs["Base Color"].default_value = (0.7, 0.8, 0.9, 1)
    gb.inputs["Alpha"].default_value = 0.12
    g.surface_render_method = "BLENDED"
    return m, g


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--blend", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--views", default="eye,up,left,right,back,top,side")
    ap.add_argument("--engine", default="EEVEE")
    ap.add_argument("--res", default="960x540")
    ap.add_argument("--samples", type=int, default=32)
    ap.add_argument("--lit", action="store_true", help="keep materials (look-dev) instead of clay")
    ap.add_argument("--cutaway", action="store_true", help="hide the ceiling/glass for top views")
    a = ap.parse_args(argv)
    bpy.ops.wm.open_mainfile(filepath=os.path.abspath(a.blend))
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_EEVEE" if a.engine.upper().startswith("EEVEE") else "CYCLES"
    if sc.render.engine == "CYCLES":
        sc.cycles.samples = a.samples
        sc.cycles.use_denoising = True
    else:
        sc.eevee.taa_render_samples = a.samples
    w, h = (int(v) for v in a.res.split("x"))
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.view_settings.view_transform = "AgX"
    sc.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("W")
    sc.world = world
    bg = world.node_tree.nodes["Background"]
    bg.inputs["Color"].default_value = (0.02, 0.025, 0.035, 1)
    bg.inputs["Strength"].default_value = 1.0

    if a.lit:
        import build_cabin_zones as BZ  # zone names, without running the builder
        LOOK.apply_materials([o for o in bpy.data.objects if o.type == "MESH"], BZ.ZONES)
        LOOK.add_lights(sc)
        bg.inputs["Color"].default_value = (0.0, 0.0, 0.0, 1)
        # a little starlight through the canopy so the unlit corners are not pure black
        key = bpy.data.lights.new("Star", "SUN")
        key.energy = float(os.environ.get("STAR_SUN", "1.5"))
        key.angle = 0.01
        key.color = (1.0, 0.93, 0.85)
        ko = bpy.data.objects.new("Star", key)
        ko.rotation_euler = (math.radians(50), 0, math.radians(140))
        sc.collection.objects.link(ko)
    if not a.lit:
        clay, glass = clay_material()
        for ob in bpy.data.objects:
            if ob.type != "MESH":
                continue
            ob.data.materials.clear()
            ob.data.materials.append(glass if ob.name.startswith(("Glass", "Porthole_") ) and ob.name.endswith("Glass") or ob.name == "Glass_Canopy" else clay)
        # soft clay lighting: a key from the front-left through the canopy and a cabin fill
        key = bpy.data.lights.new("Key", "SUN")
        key.energy = 2.2
        key.angle = 0.2
        ko = bpy.data.objects.new("Key", key)
        ko.rotation_euler = (math.radians(55), 0, math.radians(150))
        sc.collection.objects.link(ko)
        for p, e in (((0, -1.5, 2.0), 120), ((0, 0.4, 1.9), 60), ((0, -2.2, 1.0), 40)):
            l = bpy.data.lights.new("Fill", "POINT")
            l.energy = e
            l.shadow_soft_size = 0.5
            lo = bpy.data.objects.new("Fill", l)
            lo.location = p
            sc.collection.objects.link(lo)

    cam_data = bpy.data.cameras.new("Cam")
    cam = bpy.data.objects.new("Cam", cam_data)
    sc.collection.objects.link(cam)
    sc.camera = cam
    cam_data.clip_start = 0.02
    cam_data.sensor_fit = "VERTICAL"
    cam_data.sensor_height = 24.0
    os.makedirs(os.path.dirname(os.path.abspath(a.out)) or ".", exist_ok=True)
    hidden = []
    for name in a.views.split(","):
        loc, (yaw, pitch), lens = VIEWS[name]
        cam_data.lens = lens
        cam_data.type = "PERSP"
        look(cam, loc, yaw, pitch)
        for ob in hidden:
            ob.hide_render = False
        hidden = []
        if name in ("top",) or (a.cutaway and name in ("side",)):
            for ob in bpy.data.objects:
                if ob.type == "MESH" and (ob.name.startswith(("Shell_Lining", "Glass", "Frame_Arch", "Frame_Mullion"))
                                          or (name == "side" and ob.name.startswith(("Shell_Lower_R", "Porthole_Stbd")))):
                    ob.hide_render = True
                    hidden.append(ob)
        bpy.context.view_layer.update()
        # subject gate: rays through a grid of the frame must hit something
        dg = bpy.context.evaluated_depsgraph_get()
        hits = 0
        frame = cam_data.view_frame(scene=sc)
        mw = cam.matrix_world
        for u in np.linspace(0.1, 0.9, 5):
            for v in np.linspace(0.1, 0.9, 5):
                p = frame[2].lerp(frame[1], u).lerp(frame[3].lerp(frame[0], u), v)
                d = (mw @ p - mw.translation).normalized()
                ok, *_ = sc.ray_cast(dg, mw.translation, d)
                hits += ok
        if hits < 5:
            raise RuntimeError(f"view {name}: only {hits}/25 rays hit the cabin - camera not on its subject")
        sc.render.filepath = os.path.abspath(f"{a.out}_{name}.png")
        bpy.ops.render.render(write_still=True)
        print(f"VIEW {name}: {sc.render.filepath} ({hits}/25 rays on subject)")


main()
