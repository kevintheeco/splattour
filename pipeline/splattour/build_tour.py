"""Final pipeline stage: COLMAP model + trained splat → viewer scene folder.

    scenes/<name>/
      scene.ply | scene.spz   the splat (original frame; the viewer applies
                              `splatTransform` so we never resample splats)
      tour.json               nodes, edges, alignment, provenance
      build_report.json       everything a thesis table needs to reproduce
"""
from __future__ import annotations

import json
import shutil
import time
from pathlib import Path

import numpy as np

from .align import align
from .colmap_io import find_model_dir, read_model
from .graph import OccupancyGrid, build_graph
from .lights import detect_lights
from .splat_io import read_ply, splat_footprints


def build_tour(
    model_dir: str | Path,
    splat_path: str | Path,
    out_dir: str | Path,
    title: str,
    subtitle: str = "",
    capture_height: float = 1.45,
    spacing: float = 1.3,
    max_edge: float = 4.0,
    splat_frame: str = "colmap",
    copy_splat: bool = True,
) -> dict:
    t0 = time.time()
    model_dir = Path(model_dir)
    if not (model_dir / "images.bin").exists() and not (model_dir / "images.txt").exists():
        model_dir = find_model_dir(model_dir)
    model = read_model(model_dir)
    dropped = model.drop_outlier_cameras()
    imgs = model.images_sorted()
    al = align(model, capture_height=capture_height)

    centers = al.apply(np.array([im.center for im in imgs]))
    forwards = al.apply_dir(np.array([im.forward for im in imgs]))
    # A camera below the floor is mis-registered too (nobody shoots from
    # under the floorboards); keep it out of the tour graph.
    under = centers[:, 1] < 0.1
    if under.any() and not under.all():
        dropped += [im.name for im, u in zip(imgs, under) if u]
        imgs = [im for im, u in zip(imgs, under) if not u]
        centers, forwards = centers[~under], forwards[~under]

    # Occupancy from the trained splat, mapped into the aligned world frame.
    fields = read_ply(splat_path)
    if splat_frame != "colmap":
        raise NotImplementedError("only splats in the COLMAP frame are supported")
    xyz, op = splat_footprints(fields, voxel=0.08 / al.s, min_opacity=0.3)
    xyz_w = al.apply(xyz)
    lo = np.array([centers[:, 0].min() - 4, -0.5, centers[:, 2].min() - 4])
    hi = np.array([centers[:, 0].max() + 4, centers[:, 1].max() + 1.5, centers[:, 2].max() + 4])
    occ = OccupancyGrid(xyz_w, op, lo, hi)
    g = build_graph(centers, forwards, occ, floor_y=0.0, spacing=spacing, max_edge=max_edge)

    lights = detect_lights(fields, al.apply, floor_y=0.0, occ=occ)

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    splat_name = "scene" + Path(splat_path).suffix
    if copy_splat and Path(splat_path).resolve() != (out / splat_name).resolve():
        shutil.copyfile(splat_path, out / splat_name)

    for n in g.nodes:
        n["image"] = imgs[n["camera"]].name
    tour = {
        "version": 1,
        "title": title,
        "subtitle": subtitle,
        "splat": splat_name,
        "splatTransform": al.as_splat_transform(),
        "eyeHeight": round(g.stats["eye_height"], 4),
        "start": g.nodes[0]["id"],
        "nodes": g.nodes,
        "edges": [list(e) for e in g.edges],
        "fadeLinks": [list(e) for e in g.stats["fade_links"]],
        "lights": lights,
    }
    (out / "tour.json").write_text(json.dumps(tour, ensure_ascii=False, indent=2), encoding="utf-8")
    report = {
        "model_dir": str(model_dir),
        "splat": str(splat_path),
        "num_images": len(imgs),
        "num_points3d": int(len(model.xyz)),
        "num_splats": int(len(fields["x"])),
        "alignment": {**al.info, "scale": al.s},
        "graph": g.stats,
        "dropped_cameras": dropped,
        "lights": [{k: l[k] for k in ("name", "position", "score", "kind", "shell")} for l in lights],
        "params": {"capture_height": capture_height, "spacing": spacing, "max_edge": max_edge},
        "seconds": round(time.time() - t0, 2),
    }
    (out / "build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return report
