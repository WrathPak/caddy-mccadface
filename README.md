# CADdy McCADFace

[![ci](https://github.com/WrathPak/caddy-mccadface/actions/workflows/ci.yml/badge.svg)](https://github.com/WrathPak/caddy-mccadface/actions/workflows/ci.yml)

live version: https://wrathpak.github.io/caddy-mccadface/

browser cad that runs 100% on your machine. no accounts, no cloud, nothing gets uploaded. you can host it anywhere static and your files still never leave your computer.

i got tired of fighting fusion 360 for 3d printing stuff (especially hair on figures) so i'm building my own.

## what it does right now

- parametric timeline, edit any feature and everything after it rebuilds
- sketches with constraints and dimensions
- extrude, revolve, sweep, loft, fillet, chamfer, shell, combine
- import/export stl, 3mf, step
- mesh tools (plane cut, reduce, smooth, repair)
- assemblies: components with instances, linked files, joints (rigid, revolute, slider and more) snapped to faces and edges, drag and drive motion, interference check, exploded views, step and 3mf export of the structure
- hair tool: paint faces, pick a direction, get printable strands with a sacrificial wall
- saves `.caddy` project files straight to your disk

## running it

```
pnpm install
pnpm dev
```

tests: `pnpm test` (unit) and `pnpm exec playwright test` (browser). see CONTRIBUTING.md if you want to help out

## under the hood

opencascade (via replicad) for solids, manifold-3d for meshes, planegcs for the sketch solver, three.js for the viewport.

MIT licensed
