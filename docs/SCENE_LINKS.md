# Wolhajeong independent model entrances

`viewer/public/spaces/wolhajeong/nav.json` defines three independent models:

| Space | Model | Entrance |
| --- | --- | --- |
| Yard | `wolhajeong360-hq` | Yard-side arrows to sarang and anchae |
| Sarang | `wolhajeong360-sarang3` | Return arrow to yard |
| Anchae | `wolhajeong-anchae-warm-600` | Return arrow to yard |

An entrance click detaches the old model and activates the destination's own
tour, collision grid, camera, lighting and audio. The blackout stays until
Spark's displayed accumulator contains only the destination model. Models are
never overlaid or cross-faded. The existing HQ exterior remains visible from
the yard; its old anchae interior is behind the entrance movement barrier.

`mapTransform` affects only the shared map position and heading. It must never
be applied to a model or its collision grid. Anchae's map placement is an
approximate visual match of the living-room shelf/glass-door direction in the
two models, not surveyed registration. Adjust the entrance `marker`, arrival
`position`/`yaw`, `barrier`, and map transform independently when refining it.

The anchae source is the user-selected `scenes/wolhajeong-anchae-warm-600/scene.ply`.
Its SHA-256 is `108c05c3cef14401700c81ec4a1ba7dfbb810d3fbaa867d88d29dbdd15d07ff8`.
Re-encoding it with `splattour.spz.ply_to_spz` and comparing decompressed SPZ
bytes verified both existing web files: full SH3 / 2,000,000 splats and mobile
SH1 / 1,500,000 splats. These assets were uploaded on 2026-10-06 to
`https://media.3dgstour.com/scenes/wolhajeong-anchae-warm-600/`.
The published tour omits a photos index because this local export has none.

Model files are outside Git. A code PR does not publish model assets, and an
open PR is not a deployed site. The model can already be opened independently:
`https://3dgstour.com/tour.html?scene=wolhajeong-anchae-warm-600&from=cloud`.

Validation: `npm run build` in `viewer`, then from the repository root:

```sh
node viewer/scripts/scene-links-check.mjs --url=http://127.0.0.1:5297
node viewer/scripts/scene-links-check.mjs --url=http://127.0.0.1:5297 --origin=https://3dgstour.com --dist=/absolute/path/to/viewer/dist --cloud --mobile
node viewer/scripts/anchae-remote-check.mjs
```

The built-site test serves local build bytes under the production origin in
an isolated browser, fetching actual remote SPZ files. It does not deploy the
site. It checks both entrance round trips, exclusive GPU/model rendering,
collision state, map movement and heading, direct reloads, barriers, and a
failed load followed by retry. The remote check uses the actual deployed site.
