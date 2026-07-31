"""Generate HumToKeys' rigged, browser-ready concert grand piano.

Run with Blender 4.4+:
    blender --background --python tools/generate_concert_grand_piano.py

The exported GLB uses one named pivot per MIDI key. Pivot names follow the
``pivot_<midi>_<note>`` convention, e.g. ``pivot_60_C4`` and
``pivot_61_Cs4``. Three.js can animate a key by rotating that pivot on X.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIRECTORY = ROOT / "assets"
GLB_PATH = ASSET_DIRECTORY / "concert-grand-piano.glb"
MANIFEST_PATH = ASSET_DIRECTORY / "concert-grand-piano.keys.json"

PITCH_CLASSES = ("C", "Cs", "D", "Ds", "E", "F", "Fs", "G", "Gs", "A", "As", "B")
BLACK_PITCH_CLASSES = {"Cs", "Ds", "Fs", "Gs", "As"}

WHITE_KEY_PITCH = 0.0235
WHITE_KEY_WIDTH = 0.0224
WHITE_KEY_LENGTH = 0.500
BLACK_KEY_WIDTH = 0.0134
BLACK_KEY_LENGTH = 0.255
KEY_REAR_Y = WHITE_KEY_LENGTH / 2 - 0.005


def reset_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    for collection in list(bpy.data.collections):
        if collection.users == 0:
            bpy.data.collections.remove(collection)

    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


def make_material(name, color, metallic=0.0, roughness=0.4, coat=0.0):
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    material.diffuse_color = color
    principled = material.node_tree.nodes.get("Principled BSDF")
    principled.inputs["Base Color"].default_value = color
    principled.inputs["Metallic"].default_value = metallic
    principled.inputs["Roughness"].default_value = roughness
    if principled.inputs.get("Coat Weight"):
        principled.inputs["Coat Weight"].default_value = coat
        principled.inputs["Coat Roughness"].default_value = 0.1
    return material


def add_bevel(obj, width, segments=2) -> None:
    modifier = obj.modifiers.new("Rounded edges", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def apply_material(obj, material) -> None:
    obj.data.materials.clear()
    obj.data.materials.append(material)


def add_box(name, size, location, material, bevel=0.0, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        add_bevel(obj, bevel)
    apply_material(obj, material)
    return obj


def add_cylinder(name, radius, depth, location, material, vertices=16, rotation=(0.0, 0.0, 0.0)):
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    apply_material(obj, material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_sphere(name, radius, location, material):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=18, ring_count=10, radius=radius, location=location)
    obj = bpy.context.object
    obj.name = name
    apply_material(obj, material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_beam(name, start, end, radius, material, vertices=10):
    start_vector = Vector(start)
    end_vector = Vector(end)
    direction = end_vector - start_vector
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=direction.length,
        location=(start_vector + end_vector) * 0.5,
    )
    obj = bpy.context.object
    obj.name = name
    obj.rotation_mode = "XYZ"
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()
    bpy.context.view_layer.update()
    apply_material(obj, material)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_prism(name, outline, bottom, top, material, bevel=0.0):
    count = len(outline)
    vertices = [(x, y, bottom) for x, y in outline] + [(x, y, top) for x, y in outline]
    faces = [tuple(reversed(range(count))), tuple(range(count, count * 2))]
    for index in range(count):
        next_index = (index + 1) % count
        faces.append((index, next_index, count + next_index, count + index))

    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    apply_material(obj, material)
    if bevel:
        add_bevel(obj, bevel)
    return obj


def add_outline(name, points, height, radius, material, cyclic=True):
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 2
    spline = curve.splines.new("NURBS")
    spline.points.add(len(points) - 1)
    for point, coordinate in zip(spline.points, points):
        point.co = (coordinate[0], coordinate[1], 0.0, 1.0)
    spline.use_cyclic_u = cyclic
    spline.order_u = min(3, len(points))
    spline.use_endpoint_u = True
    obj = bpy.data.objects.new(name, curve)
    bpy.context.collection.objects.link(obj)
    obj.location.z = height
    curve.materials.append(material)
    return obj


def parent_keep_transform(child, parent) -> None:
    world = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = world


def note_name(midi: int) -> str:
    return f"{PITCH_CLASSES[midi % 12]}{midi // 12 - 1}"


def create_keys(root, ivory, key_ebony):
    manifest = {}
    white_midis = [midi for midi in range(21, 109) if PITCH_CLASSES[midi % 12] not in BLACK_PITCH_CLASSES]
    key_span = len(white_midis) * WHITE_KEY_PITCH
    white_x = {}

    for index, midi in enumerate(white_midis):
        note = note_name(midi)
        x = -key_span / 2 + WHITE_KEY_PITCH / 2 + index * WHITE_KEY_PITCH
        white_x[midi] = x
        pivot = bpy.data.objects.new(f"pivot_{midi}_{note}", None)
        pivot.location = (x, KEY_REAR_Y - 0.003, 0.724)
        pivot["midi"] = midi
        pivot["note"] = note
        pivot["keyType"] = "white"
        # The key fronts point toward -Y, so a positive X rotation presses them down.
        pivot["pressRadians"] = 0.08
        bpy.context.collection.objects.link(pivot)
        pivot.parent = root

        key = add_box(
            f"key_{midi}_{note}",
            (WHITE_KEY_WIDTH, WHITE_KEY_LENGTH, 0.024),
            (x, 0.0, 0.712),
            ivory,
            bevel=0.0013,
        )
        key["midi"] = midi
        parent_keep_transform(key, pivot)
        manifest[str(midi)] = pivot.name

    black_offsets = {"Cs": -0.08, "Ds": 0.08, "Fs": -0.10, "Gs": 0.0, "As": 0.10}
    for midi in range(21, 109):
        pitch_class = PITCH_CLASSES[midi % 12]
        if pitch_class not in BLACK_PITCH_CLASSES:
            continue
        note = note_name(midi)
        x = white_x[midi - 1] + WHITE_KEY_PITCH * (0.5 + black_offsets[pitch_class])
        pivot = bpy.data.objects.new(f"pivot_{midi}_{note}", None)
        pivot.location = (x, KEY_REAR_Y - 0.003, 0.758)
        pivot["midi"] = midi
        pivot["note"] = note
        pivot["keyType"] = "black"
        pivot["pressRadians"] = 0.08
        bpy.context.collection.objects.link(pivot)
        pivot.parent = root

        key = add_box(
            f"key_{midi}_{note}",
            (BLACK_KEY_WIDTH, BLACK_KEY_LENGTH, 0.038),
            (x, KEY_REAR_Y - BLACK_KEY_LENGTH / 2, 0.739),
            key_ebony,
            bevel=0.0018,
            rotation=(math.radians(-1.1), 0.0, 0.0),
        )
        key["midi"] = midi
        parent_keep_transform(key, pivot)
        manifest[str(midi)] = pivot.name

    assert len(manifest) == 88
    return dict(sorted(manifest.items(), key=lambda item: int(item[0])))


def create_grand_body(root, materials):
    ebony = materials["ebony"]
    satin_ebony = materials["satin_ebony"]
    brass = materials["brass"]
    wood = materials["wood"]
    plate = materials["plate"]
    steel = materials["steel"]
    copper = materials["copper"]

    outline = [
        (-0.80, -0.30), (0.80, -0.30), (0.80, 0.18), (0.75, 0.68),
        (0.63, 1.16), (0.45, 1.55), (0.20, 1.84), (-0.12, 1.96),
        (-0.39, 1.85), (-0.62, 1.58), (-0.77, 1.16), (-0.85, 0.60),
        (-0.84, 0.08),
    ]
    inner_outline = [(x * 0.79, y * 0.81 + 0.16) for x, y in outline]
    body = add_prism("grand_piano_body", outline, 0.48, 0.68, ebony, bevel=0.022)
    rim = add_outline("grand_piano_rounded_rim", outline, 0.70, 0.020, satin_ebony)
    soundboard = add_prism("spruce_soundboard", inner_outline, 0.686, 0.702, wood, bevel=0.008)
    plate_outline = [(x * 0.70, y * 0.72 + 0.23) for x, y in outline]
    cast_plate = add_prism("cast_iron_plate", plate_outline, 0.703, 0.718, plate, bevel=0.005)

    keyboard_bed = add_box("keyboard_bed", (1.54, 0.73, 0.095), (0.0, -0.02, 0.665), ebony, bevel=0.014)
    key_slip = add_box("key_slip", (1.34, 0.038, 0.045), (0.0, -0.275, 0.730), satin_ebony, bevel=0.004)
    fallboard = add_box("fallboard", (1.35, 0.11, 0.18), (0.0, 0.37, 0.82), ebony, bevel=0.014, rotation=(math.radians(-7), 0, 0))
    for object_ in (body, rim, soundboard, cast_plate, keyboard_bed, key_slip, fallboard):
        parent_keep_transform(object_, root)

    for index in range(38):
        fraction = index / 37
        start = (-0.49 + fraction * 0.98, 0.38, 0.735)
        end = (-0.18 + fraction * 0.46, 1.68 - fraction * 0.45, 0.738)
        string = add_beam(f"treble_string_{index + 1:02d}", start, end, 0.0011, steel, vertices=6)
        parent_keep_transform(string, root)
    for index in range(14):
        fraction = index / 13
        start = (-0.62 + fraction * 0.33, 0.36, 0.738)
        end = (-0.32 + fraction * 0.25, 1.74 - fraction * 0.16, 0.740)
        string = add_beam(f"bass_string_{index + 1:02d}", start, end, 0.00165, copper, vertices=6)
        parent_keep_transform(string, root)

    pin_block = add_box("tuning_pin_block", (1.13, 0.10, 0.075), (0.0, 0.37, 0.755), wood, bevel=0.006)
    parent_keep_transform(pin_block, root)
    for index in range(30):
        x = -0.51 + index * (1.02 / 29)
        pin = add_cylinder(f"tuning_pin_{index + 1:02d}", 0.006, 0.038, (x, 0.39 + (index % 2) * 0.018, 0.800), brass, vertices=8)
        parent_keep_transform(pin, root)

    lid_outline = [(x * 0.97, y * 0.97 + 0.02) for x, y in outline]
    lid = add_prism("raised_lid", lid_outline, 0.0, 0.030, ebony, bevel=0.012)
    lid.location = (-0.02, 0.23, 1.02)
    lid.rotation_euler = (math.radians(-24), 0.0, 0.0)
    parent_keep_transform(lid, root)
    lid_under = add_prism("lid_spruce_underside", [(x * 0.90, y * 0.90 + 0.10) for x, y in outline], 0.0, 0.010, wood, bevel=0.004)
    lid_under.location = (-0.02, 0.23, 1.014)
    lid_under.rotation_euler = (math.radians(-24), 0.0, 0.0)
    parent_keep_transform(lid_under, root)
    lid_prop = add_beam("lid_prop", (0.38, 0.88, 0.73), (0.38, 1.15, 1.28), 0.014, brass)
    parent_keep_transform(lid_prop, root)

    desk = add_box("music_desk", (0.82, 0.035, 0.31), (0.0, 0.54, 1.00), satin_ebony, bevel=0.006, rotation=(math.radians(-11), 0.0, 0.0))
    desk_ledge = add_box("music_desk_ledge", (0.91, 0.07, 0.040), (0.0, 0.49, 0.86), ebony, bevel=0.008)
    parent_keep_transform(desk, root)
    parent_keep_transform(desk_ledge, root)
    for index in range(7):
        slat = add_box(f"music_desk_slat_{index + 1}", (0.018, 0.028, 0.27), (-0.30 + index * 0.10, 0.525, 1.0), ebony, bevel=0.002, rotation=(math.radians(-11), 0.0, 0.0))
        parent_keep_transform(slat, root)

    legs = [(-0.63, -0.13), (0.63, -0.13), (-0.29, 1.50)]
    for index, (x, y) in enumerate(legs, 1):
        leg = add_cylinder(f"leg_{index}", 0.066, 0.49, (x, y, 0.25), ebony, vertices=18)
        foot = add_cylinder(f"foot_{index}", 0.105, 0.055, (x, y, 0.027), satin_ebony, vertices=18)
        caster = add_sphere(f"caster_{index}", 0.031, (x, y + 0.018, -0.016), brass)
        for object_ in (leg, foot, caster):
            parent_keep_transform(object_, root)

    for side in (-1, 1):
        lyre = add_beam(f"lyre_{'left' if side < 0 else 'right'}", (side * 0.105, -0.19, 0.15), (side * 0.135, 0.05, 0.57), 0.015, ebony)
        parent_keep_transform(lyre, root)
    for index, x in enumerate((-0.075, 0.0, 0.075), 1):
        pedal = add_box(f"pedal_{index}", (0.062, 0.15, 0.018), (x, -0.33, 0.095), brass, bevel=0.010, rotation=(math.radians(-7), 0, 0))
        stem = add_beam(f"pedal_stem_{index}", (x, -0.22, 0.16), (x, -0.30, 0.10), 0.009, brass)
        parent_keep_transform(pedal, root)
        parent_keep_transform(stem, root)


def export_model() -> None:
    ASSET_DIRECTORY.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        use_selection=False,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=True,
    )


def build() -> None:
    reset_scene()
    ASSET_DIRECTORY.mkdir(parents=True, exist_ok=True)
    root = bpy.data.objects.new("HumToKeys_ConcertGrand", None)
    root["asset"] = "HumToKeys concert grand piano"
    root["keyPressAxis"] = "local X"
    root["keyPressRadians"] = -0.08
    bpy.context.collection.objects.link(root)

    materials = {
        "ebony": make_material("Glossy ebony", (0.012, 0.006, 0.004, 1), roughness=0.13, coat=0.82),
        "satin_ebony": make_material("Satin ebony", (0.027, 0.013, 0.008, 1), roughness=0.24, coat=0.38),
        "ivory": make_material("Warm ivory", (0.86, 0.82, 0.72, 1), roughness=0.28, coat=0.17),
        "key_ebony": make_material("Black key ebony", (0.006, 0.006, 0.008, 1), roughness=0.13, coat=0.62),
        "brass": make_material("Antique brass", (0.35, 0.18, 0.045, 1), metallic=0.87, roughness=0.22),
        "wood": make_material("Spruce soundboard", (0.43, 0.20, 0.072, 1), roughness=0.34),
        "plate": make_material("Cast iron plate", (0.42, 0.24, 0.065, 1), metallic=0.68, roughness=0.25),
        "steel": make_material("Steel strings", (0.36, 0.40, 0.46, 1), metallic=0.92, roughness=0.17),
        "copper": make_material("Copper strings", (0.34, 0.10, 0.028, 1), metallic=0.80, roughness=0.22),
    }
    manifest = create_keys(root, materials["ivory"], materials["key_ebony"])
    create_grand_body(root, materials)
    MANIFEST_PATH.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    export_model()

    triangle_count = sum(len(obj.data.polygons) for obj in bpy.context.scene.objects if obj.type == "MESH")
    print(f"Exported {GLB_PATH}")
    print(f"Exported {MANIFEST_PATH}")
    print(f"88 rigged keys, approx. {triangle_count:,} mesh faces, {GLB_PATH.stat().st_size / 1024 / 1024:.2f} MB")


if __name__ == "__main__":
    build()
