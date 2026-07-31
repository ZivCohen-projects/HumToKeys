"""Generate the HumToKeys interactive music-room environment.

Run with Blender 4.4+:
    blender --background --python tools/generate_humtokeys_music_room.py

The exported room uses Three.js-friendly coordinates: X left/right, Y up,
Z from the entrance toward the rear wall. The floor surface is Y=0.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

import bpy
from mathutils import Vector


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"
GLB_PATH = ASSETS / "humtokeys-music-room.glb"
MANIFEST_PATH = ASSETS / "humtokeys-music-room.interactions.json"

ROOM_WIDTH = 10.0
ROOM_DEPTH = 9.0
ROOM_HEIGHT = 3.55
WALL_THICKNESS = 0.18


def g2b(point):
    """Convert the desired GLB Y-up coordinates into Blender Z-up space."""
    x, y, z = point
    return Vector((x, -z, y))


def g2b_dimensions(size):
    x, y, z = size
    return (x, z, y)


def reset_scene():
    if bpy.context.object and bpy.context.object.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for data in (bpy.data.meshes, bpy.data.curves, bpy.data.materials):
        for item in list(data):
            if item.users == 0:
                data.remove(item)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1.0


def collection(name):
    result = bpy.data.collections.new(name)
    bpy.context.scene.collection.children.link(result)
    return result


def move_to_collection(obj, target):
    for parent in list(obj.users_collection):
        parent.objects.unlink(obj)
    target.objects.link(obj)


def apply_scale(obj):
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.select_set(False)


def bevel(obj, width, segments=2):
    modifier = obj.modifiers.new("EdgeSoftening", "BEVEL")
    modifier.width = width
    modifier.segments = segments
    modifier.limit_method = "ANGLE"
    bpy.ops.object.select_all(action="DESELECT")
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=modifier.name)
    obj.select_set(False)


def material(name, color, metallic=0.0, roughness=0.5, coat=0.0, emission=None):
    result = bpy.data.materials.new(name)
    result.use_nodes = True
    result.diffuse_color = color
    bsdf = result.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if bsdf.inputs.get("Coat Weight"):
        bsdf.inputs["Coat Weight"].default_value = coat
        bsdf.inputs["Coat Roughness"].default_value = 0.12
    if emission:
        if bsdf.inputs.get("Emission Color"):
            bsdf.inputs["Emission Color"].default_value = emission[0]
            bsdf.inputs["Emission Strength"].default_value = emission[1]
        else:
            bsdf.inputs["Emission"].default_value = emission[0]
            bsdf.inputs["Emission Strength"].default_value = emission[1]
    return result


def assign_material(obj, value):
    obj.data.materials.clear()
    obj.data.materials.append(value)


def add_box(name, size, location, target, value, rounding=0.0, rotation_y=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=g2b(location))
    obj = bpy.context.object
    obj.name = name
    obj.dimensions = g2b_dimensions(size)
    # Desired Y-up yaw maps to Blender's Z rotation.
    obj.rotation_euler.z = rotation_y
    apply_scale(obj)
    if rounding:
        bevel(obj, rounding)
    assign_material(obj, value)
    move_to_collection(obj, target)
    return obj


def add_cylinder(name, radius, height, location, target, value, axis="Y", vertices=14):
    rotation = (0.0, 0.0, 0.0)
    if axis == "X":
        rotation = (0.0, math.pi / 2, 0.0)
    elif axis == "Z":
        rotation = (math.pi / 2, 0.0, 0.0)
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=height,
        location=g2b(location),
        rotation=rotation,
    )
    obj = bpy.context.object
    obj.name = name
    assign_material(obj, value)
    move_to_collection(obj, target)
    for polygon in obj.data.polygons:
        polygon.use_smooth = len(polygon.vertices) <= 4
    return obj


def add_sphere(name, radius, location, target, value, scale=(1.0, 1.0, 1.0)):
    bpy.ops.mesh.primitive_uv_sphere_add(
        segments=16,
        ring_count=10,
        radius=radius,
        location=g2b(location),
    )
    obj = bpy.context.object
    obj.name = name
    # Desired X/Y/Z scale maps to Blender X/Z/Y.
    obj.scale = (scale[0], scale[2], scale[1])
    apply_scale(obj)
    assign_material(obj, value)
    move_to_collection(obj, target)
    for polygon in obj.data.polygons:
        polygon.use_smooth = True
    return obj


def add_empty(name, location, target, yaw=0.0):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = "PLAIN_AXES"
    obj.empty_display_size = 0.16
    obj.location = g2b(location)
    obj.rotation_euler.z = yaw
    target.objects.link(obj)
    return obj


def extras(obj, **values):
    for key, value in values.items():
        obj[key] = json.dumps(value, separators=(",", ":")) if isinstance(value, (dict, list, tuple)) else value


def parent_all(root, objects):
    for obj in objects:
        obj.parent = root


def add_floor(root, target, mats):
    created = []
    created.append(add_box("room_floor", (ROOM_WIDTH, 0.16, ROOM_DEPTH), (0, -0.08, ROOM_DEPTH / 2), target, mats["walnut"]))
    plank_width = 0.38
    plank_depth = 0.48
    for row in range(19):
        for column in range(27):
            x = -ROOM_WIDTH / 2 + 0.19 + column * plank_width + (0.19 if row % 2 else 0)
            z = 0.24 + row * plank_depth
            if x > ROOM_WIDTH / 2:
                continue
            created.append(add_box(
                f"floorboard_{row:02d}_{column:02d}",
                (plank_width - 0.012, 0.024, plank_depth - 0.010),
                (x, 0.012, z),
                target,
                mats["walnut_alt"] if (row + column) % 3 == 0 else mats["walnut"],
                0.002,
            ))
    return created


def add_architecture(root, target, mats):
    created = []
    wall = mats["wall"]
    trim = mats["trim"]
    created.extend([
        add_box("wall_back", (ROOM_WIDTH, ROOM_HEIGHT, WALL_THICKNESS), (0, ROOM_HEIGHT / 2, ROOM_DEPTH + WALL_THICKNESS / 2), target, wall),
        add_box("wall_left", (WALL_THICKNESS, ROOM_HEIGHT, ROOM_DEPTH), (-ROOM_WIDTH / 2 - WALL_THICKNESS / 2, ROOM_HEIGHT / 2, ROOM_DEPTH / 2), target, wall),
        add_box("wall_right", (WALL_THICKNESS, ROOM_HEIGHT, ROOM_DEPTH), (ROOM_WIDTH / 2 + WALL_THICKNESS / 2, ROOM_HEIGHT / 2, ROOM_DEPTH / 2), target, wall),
        add_box("wall_front_left", (4.15, ROOM_HEIGHT, WALL_THICKNESS), (-2.925, ROOM_HEIGHT / 2, -WALL_THICKNESS / 2), target, wall),
        add_box("wall_front_right", (4.15, ROOM_HEIGHT, WALL_THICKNESS), (2.925, ROOM_HEIGHT / 2, -WALL_THICKNESS / 2), target, wall),
        add_box("wall_front_header", (1.7, 1.0, WALL_THICKNESS), (0, 3.05, -WALL_THICKNESS / 2), target, wall),
        add_box("room_ceiling", (ROOM_WIDTH, 0.14, ROOM_DEPTH), (0, ROOM_HEIGHT + 0.07, ROOM_DEPTH / 2), target, mats["plaster"]),
        add_box("baseboard_back", (ROOM_WIDTH, 0.14, 0.06), (0, 0.07, ROOM_DEPTH - 0.03), target, trim, 0.01),
        add_box("baseboard_left", (0.06, 0.14, ROOM_DEPTH), (-ROOM_WIDTH / 2 + 0.03, 0.07, ROOM_DEPTH / 2), target, trim, 0.01),
        add_box("baseboard_right", (0.06, 0.14, ROOM_DEPTH), (ROOM_WIDTH / 2 - 0.03, 0.07, ROOM_DEPTH / 2), target, trim, 0.01),
        add_box("crown_back", (ROOM_WIDTH, 0.14, 0.09), (0, ROOM_HEIGHT - 0.07, ROOM_DEPTH - 0.045), target, trim, 0.012),
        add_box("entrance_door", (1.52, 2.48, 0.075), (0, 1.24, 0.015), target, mats["walnut_alt"], 0.018),
        add_sphere("entrance_door_knob", 0.045, (0.47, 1.05, -0.04), target, mats["brass"]),
    ])

    # Two deep night windows along the left wall.
    for index, z in enumerate((2.45, 6.2), 1):
        created.extend([
            add_box(f"window_frame_{index}", (0.08, 2.35, 1.78), (-4.96, 1.84, z), target, trim, 0.016),
            add_box(f"window_night_{index}", (0.025, 2.08, 1.48), (-4.90, 1.84, z), target, mats["night"]),
            add_box(f"window_vertical_{index}", (0.05, 2.08, 0.045), (-4.875, 1.84, z), target, trim, 0.004),
            add_box(f"window_horizontal_{index}", (0.05, 0.045, 1.48), (-4.875, 1.84, z), target, trim, 0.004),
            add_box(f"curtain_{index}_front", (0.16, 2.48, 0.43), (-4.75, 1.72, z - 0.93), target, mats["curtain"], 0.05),
            add_box(f"curtain_{index}_rear", (0.16, 2.43, 0.43), (-4.75, 1.72, z + 0.93), target, mats["curtain"], 0.05),
            add_cylinder(f"curtain_rod_{index}", 0.022, 2.24, (-4.75, 3.15, z), target, mats["brass"], "Z"),
        ])
    return created


def add_rug(root, target, mats):
    created = [
        add_box("central_rug", (4.55, 0.03, 3.9), (0, 0.02, 4.55), target, mats["rug"], 0.075),
        add_box("rug_inner_border", (4.12, 0.012, 3.47), (0, 0.042, 4.55), target, mats["rug_detail"], 0.055),
        add_box("rug_center", (3.82, 0.012, 3.17), (0, 0.051, 4.55), target, mats["rug"], 0.045),
    ]
    for index in range(5):
        created.append(add_box(
            f"rug_music_motif_{index}",
            (0.09 + index * 0.025, 0.009, 0.55 - index * 0.05),
            (-0.68 + index * 0.34, 0.06, 4.55 + (index % 2) * 0.13),
            target,
            mats["rug_detail"],
            0.015,
        ))
    return created


def add_bookshelf(prefix, x, z, root, target, mats, seed):
    created = []
    created.extend([
        add_box(f"{prefix}_back", (0.42, 2.6, 1.6), (x, 1.3, z), target, mats["walnut"], 0.014),
        add_box(f"{prefix}_left", (0.48, 2.65, 0.1), (x, 1.325, z - 0.75), target, mats["walnut_alt"], 0.012),
        add_box(f"{prefix}_right", (0.48, 2.65, 0.1), (x, 1.325, z + 0.75), target, mats["walnut_alt"], 0.012),
        add_box(f"{prefix}_top", (0.5, 0.12, 1.72), (x, 2.58, z), target, mats["walnut_alt"], 0.014),
        add_box(f"{prefix}_base", (0.54, 0.15, 1.76), (x, 0.075, z), target, mats["walnut_alt"], 0.016),
    ])
    for shelf_index, shelf_y in enumerate((0.56, 1.08, 1.60, 2.10), 1):
        created.append(add_box(f"{prefix}_shelf_{shelf_index}", (0.48, 0.055, 1.52), (x, shelf_y, z), target, mats["walnut_alt"], 0.006))
        cursor = z - 0.62
        book_index = 0
        while cursor < z + 0.62:
            book_depth = 0.045 + ((book_index + seed) % 4) * 0.012
            book_height = 0.25 + ((book_index * 2 + seed) % 5) * 0.038
            if cursor + book_depth > z + 0.65:
                break
            book_mat = (mats["book_red"], mats["book_green"], mats["book_blue"], mats["paper"])[(book_index + shelf_index + seed) % 4]
            created.append(add_box(
                f"{prefix}_book_{shelf_index}_{book_index:02d}",
                (0.25, book_height, book_depth),
                (x - 0.15, shelf_y + 0.03 + book_height / 2, cursor + book_depth / 2),
                target,
                book_mat,
                0.004,
            ))
            cursor += book_depth + 0.016
            book_index += 1
    return created


def add_lived_in_details(root, target, mats):
    created = []
    created.extend(add_bookshelf("bookshelf_front", 4.68, 2.0, root, target, mats, 2))
    created.extend(add_bookshelf("bookshelf_back", 4.68, 6.55, root, target, mats, 7))
    # Chair and side table at the left side of the room.
    created.extend([
        add_box("chair_seat", (0.68, 0.12, 0.68), (-2.55, 0.53, 5.0), target, mats["upholstery"], 0.06, -0.20),
        add_box("chair_back", (0.68, 0.80, 0.12), (-2.67, 1.03, 5.27), target, mats["upholstery"], 0.06, -0.20),
        add_cylinder("table_top", 0.50, 0.07, (-3.55, 0.71, 5.95), target, mats["walnut_alt"], "Y", 20),
        add_cylinder("table_pedestal", 0.07, 0.65, (-3.55, 0.36, 5.95), target, mats["walnut_alt"], "Y"),
        add_cylinder("table_foot", 0.31, 0.06, (-3.55, 0.03, 5.95), target, mats["walnut_alt"], "Y", 18),
        add_box("sheet_music_1", (0.34, 0.007, 0.25), (-3.53, 0.75, 5.95), target, mats["paper"], 0.003),
        add_box("sheet_music_2", (0.34, 0.007, 0.25), (-3.50, 0.757, 5.99), target, mats["paper"], 0.003),
        add_box("music_book_stack_1", (0.31, 0.045, 0.22), (-3.37, 0.79, 6.08), target, mats["book_green"], 0.006),
        add_box("music_book_stack_2", (0.31, 0.045, 0.22), (-3.36, 0.838, 6.09), target, mats["book_red"], 0.006),
        add_box("metronome_body", (0.24, 0.38, 0.17), (-3.63, 0.95, 5.81), target, mats["walnut_alt"], 0.025),
        add_cylinder("metronome_pendulum", 0.008, 0.34, (-3.61, 1.14, 5.72), target, mats["brass"], "Y", 8),
    ])
    for index, (dx, dz) in enumerate(((-0.24, -0.24), (0.24, -0.24), (-0.24, 0.24), (0.24, 0.24)), 1):
        created.append(add_cylinder(f"chair_leg_{index}", 0.032, 0.48, (-2.55 + dx, 0.24, 5.0 + dz), target, mats["walnut_alt"], "Y", 10))

    # A generic cello-shaped decorative instrument in a far corner.
    created.extend([
        add_sphere("corner_cello_lower", 0.48, (-4.03, 0.58, 7.62), target, mats["walnut_alt"], (0.50, 0.70, 0.24)),
        add_sphere("corner_cello_upper", 0.34, (-4.10, 1.12, 7.62), target, mats["walnut_alt"], (0.48, 0.65, 0.20)),
        add_box("corner_cello_neck", (0.09, 0.82, 0.07), (-4.18, 1.56, 7.60), target, mats["walnut"], 0.014),
        add_sphere("corner_cello_scroll", 0.09, (-4.20, 2.01, 7.60), target, mats["walnut_alt"]),
        add_cylinder("corner_cello_endpin", 0.012, 0.22, (-3.99, 0.11, 7.62), target, mats["brass"], "Y", 8),
    ])
    return created


def add_music_stand(root, target, anchors, mats):
    created = [
        add_cylinder("music_stand_post", 0.035, 1.08, (1.78, 0.54, 4.10), target, mats["walnut_alt"], "Y", 12),
        add_cylinder("music_stand_base", 0.28, 0.06, (1.78, 0.03, 4.10), target, mats["walnut_alt"], "Y", 16),
        add_box("music_stand_tray", (0.92, 0.56, 0.06), (1.78, 1.15, 4.10), target, mats["walnut_alt"], 0.018),
        add_box("music_stand_ledge", (0.96, 0.06, 0.10), (1.78, 0.92, 4.03), target, mats["walnut_alt"], 0.009),
    ]
    anchor = add_empty("music_stand_anchor", (1.78, 1.16, 4.03), anchors)
    extras(anchor, anchorType="live_score", recommendedSizeMeters=[0.82, 0.50])
    return created, anchor


def add_floor_lamp(root, target, mats):
    return [
        add_cylinder("record_lamp_base", 0.27, 0.06, (1.72, 0.03, 7.76), target, mats["brass"], "Y", 18),
        add_cylinder("record_lamp_stem", 0.025, 1.72, (1.72, 0.89, 7.76), target, mats["brass"], "Y", 12),
        add_sphere("record_lamp_shade", 0.25, (1.72, 1.90, 7.76), target, mats["lamp"], (1.18, 0.70, 1.18)),
        add_sphere("record_lamp_glow", 0.10, (1.72, 1.85, 7.76), target, mats["glow"]),
    ]


def add_picture_light(prefix, x, y, target, mats):
    return [
        add_box(f"{prefix}_picture_mount", (0.18, 0.10, 0.08), (x, y, 8.78), target, mats["brass"], 0.015),
        add_cylinder(f"{prefix}_picture_bar", 0.022, 0.76, (x, y - 0.08, 8.70), target, mats["brass"], "X", 12),
        add_box(f"{prefix}_picture_glow", (0.70, 0.035, 0.035), (x, y - 0.12, 8.66), target, mats["glow"], 0.01),
    ]


def add_control_painting(name, canvas_name, interaction, x, y, width, height, root, controls, decor, mats, emphasized=False):
    frame_mat = mats["brass"] if emphasized else mats["frame"]
    frame_w = 0.115 if emphasized else 0.09
    z = 8.89
    painting = add_box(name, (width, height, 0.07), (x, y, z), controls, mats["panel"], 0.03)
    extras(painting, interactionType=interaction, canvasName=canvas_name, clickable=True, cursor="pointer")
    canvas = add_box(canvas_name, (width - 0.17, height - 0.17, 0.018), (x, y, 8.84), controls, mats["canvas"], 0.012)
    extras(canvas, interactionType=interaction, paintingName=name, replaceableCanvas=True, dynamicTexture=True)
    outer_w = width + 0.20
    outer_h = height + 0.20
    pieces = [
        add_box(f"{name}_frame_top", (outer_w, frame_w, 0.12), (x, y + outer_h / 2, 8.86), decor, frame_mat, 0.024),
        add_box(f"{name}_frame_bottom", (outer_w, frame_w, 0.12), (x, y - outer_h / 2, 8.86), decor, frame_mat, 0.024),
        add_box(f"{name}_frame_left", (frame_w, outer_h, 0.12), (x - outer_w / 2, y, 8.86), decor, frame_mat, 0.024),
        add_box(f"{name}_frame_right", (frame_w, outer_h, 0.12), (x + outer_w / 2, y, 8.86), decor, frame_mat, 0.024),
        add_box(f"{name}_plaque", (0.52 if emphasized else 0.42, 0.12, 0.028), (x, y - outer_h / 2 - 0.14, 8.83), decor, mats["brass"], 0.020),
    ]
    pieces.extend(add_picture_light(name, x, y + outer_h / 2 + 0.34, decor, mats))
    return painting, canvas, pieces


def add_decorative_art(root, target, mats):
    created = [
        add_box("abstract_art_frame", (0.12, 1.35, 1.05), (4.86, 1.88, 4.38), target, mats["frame"], 0.04),
        add_box("abstract_art_canvas", (0.025, 1.10, 0.80), (4.80, 1.88, 4.38), target, mats["art"], 0.012),
    ]
    for index in range(5):
        created.append(add_box(
            f"abstract_art_mark_{index}",
            (0.014, 0.15 + index * 0.07, 0.065),
            (4.77, 1.52 + index * 0.16, 4.12 + index * 0.10),
            target,
            mats["art_a"] if index % 2 == 0 else mats["art_b"],
            0.01,
        ))
    return created


def add_anchors(root, target):
    positions = {
        "piano_anchor": (0.0, 0.016, 4.12),
        "room_spawn": (0.0, 1.64, 0.85),
        "camera_focus_piano": (4.15, 2.15, 1.65),
        "nav_entrance": (0.0, 1.64, 0.85),
        "nav_piano": (0.0, 1.68, 1.55),
        "nav_record_painting": (0.0, 1.68, 6.55),
        "nav_score_painting": (-2.40, 1.68, 6.55),
        "nav_clear_painting": (2.40, 1.68, 6.55),
    }
    result = {name: add_empty(name, point, target) for name, point in positions.items()}
    extras(result["piano_anchor"], anchorType="external_gltf", asset="concert-grand-piano.glb", floorY=0.0, forwardAxis="+Z")
    extras(result["room_spawn"], anchorType="spawn", eyeHeight=1.64, lookAt="piano_anchor")
    extras(result["camera_focus_piano"], anchorType="camera_destination", lookAt="piano_anchor", durationMs=850)
    return result


def add_collisions(root, target, mats):
    specs = [
        ("collision_wall_back", (10.0, 3.55, 0.26), (0, 1.775, 9.02), "wall"),
        ("collision_wall_left", (0.26, 3.55, 9.0), (-5.02, 1.775, 4.5), "wall"),
        ("collision_wall_right", (0.26, 3.55, 9.0), (5.02, 1.775, 4.5), "wall"),
        ("collision_piano_area", (2.20, 1.25, 2.90), (0, 0.625, 4.85), "piano"),
        ("collision_bookshelf_front", (0.7, 2.6, 1.8), (4.65, 1.3, 2.0), "furniture"),
        ("collision_bookshelf_back", (0.7, 2.6, 1.8), (4.65, 1.3, 6.55), "furniture"),
        ("collision_chair", (0.95, 1.35, 0.95), (-2.55, 0.675, 5.0), "furniture"),
        ("collision_table", (1.10, 1.25, 1.10), (-3.55, 0.625, 5.95), "furniture"),
        ("collision_music_stand", (1.05, 1.40, 0.75), (1.78, 0.70, 4.10), "furniture"),
        ("collision_record_lamp", (0.7, 2.30, 0.7), (1.72, 1.15, 7.76), "furniture"),
    ]
    result = []
    for name, size, point, category in specs:
        obj = add_box(name, size, point, target, mats["collision"])
        extras(obj, collision=True, collisionType="box", collisionCategory=category, visibleByDefault=False)
        result.append(obj)
    return result


def build_manifest():
    return {
        "version": 1,
        "asset": "humtokeys-music-room.glb",
        "coordinateSystem": {"up": "+Y", "forward": "+Z", "floorY": 0.0, "units": "meters"},
        "externalAssets": {"piano": {"url": "concert-grand-piano.glb", "anchor": "piano_anchor"}},
        "controls": {
            "record": {"painting": "painting_record_control", "canvas": "canvas_record_control", "interactionType": "record_control", "states": [{"id": "idle", "label": "Press to record"}, {"id": "recording", "label": "Press to stop recording"}, {"id": "ready", "label": "Play recording"}]},
            "score": {"painting": "painting_score_control", "canvas": "canvas_score_control", "interactionType": "score_control", "defaultLabel": "Open score"},
            "clear": {"painting": "painting_clear_control", "canvas": "canvas_clear_control", "interactionType": "clear_control", "defaultLabel": "Clear recording"},
        },
        "anchors": {"piano": "piano_anchor", "musicStand": "music_stand_anchor", "spawn": "room_spawn", "cameraFocusPiano": "camera_focus_piano"},
        "navigation": {"entrance": "nav_entrance", "piano": "nav_piano", "recordPainting": "nav_record_painting", "scorePainting": "nav_score_painting", "clearPainting": "nav_clear_painting"},
        "collisions": ["collision_wall_back", "collision_wall_left", "collision_wall_right", "collision_piano_area", "collision_bookshelf_front", "collision_bookshelf_back", "collision_chair", "collision_table", "collision_music_stand", "collision_record_lamp"],
    }


def validate():
    required = {
        "piano_anchor": "EMPTY",
        "painting_record_control": "MESH",
        "canvas_record_control": "MESH",
        "painting_score_control": "MESH",
        "canvas_score_control": "MESH",
        "painting_clear_control": "MESH",
        "canvas_clear_control": "MESH",
        "music_stand_anchor": "EMPTY",
        "room_spawn": "EMPTY",
        "camera_focus_piano": "EMPTY",
    }
    for name, expected_type in required.items():
        obj = bpy.data.objects.get(name)
        if not obj or obj.type != expected_type:
            raise RuntimeError(f"Missing required {expected_type.lower()}: {name}")
    for name in ("painting_record_control", "painting_score_control", "painting_clear_control"):
        if "interactionType" not in bpy.data.objects[name]:
            raise RuntimeError(f"Missing interactionType on {name}")
    if any(obj.type in {"CAMERA", "LIGHT"} for obj in bpy.context.scene.objects):
        raise RuntimeError("The room asset must not export Blender cameras or lights")


def triangle_count():
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            total += len(mesh.loop_triangles)
        finally:
            evaluated.to_mesh_clear()
    return total


def build():
    reset_scene()
    ASSETS.mkdir(parents=True, exist_ok=True)
    architecture = collection("ARCHITECTURE")
    furniture = collection("FURNITURE")
    decor = collection("DECOR")
    controls = collection("INTERACTIVE_CONTROLS")
    anchors = collection("ANCHORS")
    collisions = collection("COLLISIONS")

    root = bpy.data.objects.new("HumToKeys_MusicRoom", None)
    bpy.context.scene.collection.objects.link(root)
    extras(root, asset="HumToKeys music room", units="meters", coordinateSystem="X=left/right,Y=up,Z=entrance-to-back", floorY=0.0)

    mats = {
        "wall": material("Wall_Deep_Green", (0.024, 0.095, 0.070, 1), roughness=0.66),
        "plaster": material("Ceiling_Warm_Plaster", (0.53, 0.48, 0.38, 1), roughness=0.76),
        "walnut": material("Walnut_Dark", (0.078, 0.024, 0.012, 1), roughness=0.34, coat=0.20),
        "walnut_alt": material("Walnut_Warm", (0.135, 0.043, 0.018, 1), roughness=0.31, coat=0.24),
        "trim": material("Wood_Trim", (0.18, 0.068, 0.025, 1), roughness=0.28, coat=0.28),
        "frame": material("Frame_Wood", (0.105, 0.028, 0.012, 1), roughness=0.24, coat=0.36),
        "brass": material("Brass", (0.38, 0.20, 0.050, 1), metallic=0.88, roughness=0.22),
        "paper": material("Paper_Ivory", (0.78, 0.70, 0.56, 1), roughness=0.72),
        "book_red": material("Book_Burgundy", (0.26, 0.028, 0.025, 1), roughness=0.58),
        "book_green": material("Book_Forest", (0.028, 0.16, 0.085, 1), roughness=0.58),
        "book_blue": material("Book_Blue", (0.025, 0.062, 0.15, 1), roughness=0.58),
        "upholstery": material("Chair_Upholstery", (0.28, 0.035, 0.038, 1), roughness=0.72),
        "curtain": material("Curtain_Burgundy", (0.20, 0.015, 0.025, 1), roughness=0.76),
        "night": material("Night_Glass", (0.008, 0.022, 0.060, 1), roughness=0.20, coat=0.52, emission=((0.008, 0.017, 0.045, 1), 0.18)),
        "rug": material("Rug_Deep_Red", (0.22, 0.020, 0.026, 1), roughness=0.82),
        "rug_detail": material("Rug_Gold", (0.31, 0.15, 0.042, 1), roughness=0.70),
        "panel": material("Control_Backboard", (0.025, 0.016, 0.010, 1), roughness=0.36, coat=0.18),
        "canvas": material("Control_Canvas", (0.048, 0.030, 0.020, 1), roughness=0.62),
        "lamp": material("Lamp_Shade", (0.55, 0.32, 0.12, 1), roughness=0.62, emission=((0.25, 0.10, 0.022, 1), 0.18)),
        "glow": material("Warm_Glow", (0.78, 0.36, 0.07, 1), roughness=0.42, emission=((1.0, 0.25, 0.03, 1), 1.9)),
        "art": material("Abstract_Canvas", (0.14, 0.10, 0.072, 1), roughness=0.72),
        "art_a": material("Abstract_Brass", (0.44, 0.22, 0.045, 1), metallic=0.25, roughness=0.42),
        "art_b": material("Abstract_Blue", (0.025, 0.085, 0.17, 1), roughness=0.58),
        "collision": material("Collision_Hidden", (0.0, 0.0, 0.0, 0.0), roughness=1.0),
    }

    created = []
    created.extend(add_floor(root, architecture, mats))
    created.extend(add_architecture(root, architecture, mats))
    created.extend(add_rug(root, furniture, mats))
    created.extend(add_lived_in_details(root, furniture, mats))
    stand, stand_anchor = add_music_stand(root, furniture, anchors, mats)
    created.extend(stand)
    created.extend(add_floor_lamp(root, decor, mats))
    record, record_canvas, record_parts = add_control_painting("painting_record_control", "canvas_record_control", "record_control", 0.0, 1.78, 1.35, 1.82, root, controls, decor, mats, True)
    score, score_canvas, score_parts = add_control_painting("painting_score_control", "canvas_score_control", "score_control", -2.42, 1.78, 1.14, 1.55, root, controls, decor, mats)
    clear, clear_canvas, clear_parts = add_control_painting("painting_clear_control", "canvas_clear_control", "clear_control", 2.42, 1.78, 1.14, 1.55, root, controls, decor, mats)
    created.extend(record_parts + score_parts + clear_parts)
    created.extend(add_decorative_art(root, decor, mats))
    anchors_map = add_anchors(root, anchors)
    created.extend(add_collisions(root, collisions, mats))

    # Keep every authored part under one exported root, preserving world transforms.
    for obj in bpy.context.scene.objects:
        if obj is not root and obj.parent is None:
            obj.parent = root

    extras(record, stateOrder=["idle", "recording", "ready"], labels=["Press to record", "Press to stop recording", "Play recording"])
    extras(record_canvas, initialState="idle", initialLabel="Press to record")
    extras(score_canvas, initialLabel="Open score")
    extras(clear_canvas, initialLabel="Clear recording")
    validate()
    MANIFEST_PATH.write_text(json.dumps(build_manifest(), indent=2), encoding="utf-8")
    count = triangle_count()
    if count > 150000:
        raise RuntimeError(f"Triangle budget exceeded: {count:,}")
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_PATH),
        export_format="GLB",
        export_apply=True,
        export_yup=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_animations=False,
        export_extras=True,
    )
    size_mb = GLB_PATH.stat().st_size / 1024 / 1024
    if size_mb > 15:
        raise RuntimeError(f"GLB size budget exceeded: {size_mb:.2f} MB")
    print(f"Exported {GLB_PATH}")
    print(f"Exported {MANIFEST_PATH}")
    print(f"Room triangles: {count:,}; GLB size: {size_mb:.2f} MB")


if __name__ == "__main__":
    build()
