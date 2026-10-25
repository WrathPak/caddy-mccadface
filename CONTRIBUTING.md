# Contributing

thanks for poking around. this is a one person hobby project so things are a bit loose, but a few rules keep it from breaking.

## running it

```
pnpm install
pnpm dev
```

then open the url vite prints. everything runs in the browser, there's no backend.

## adding a feature

features are registered with `registerFeature` from `src/doc/registry.ts`. the easiest way in is to copy a small one like `src/features/offsetPlane.ts`:

1. write a param schema (`ParamSchema`) for the inspector fields
2. call `registerFeature({ type, label, icon, schema, compute, preview })`. `compute` builds the geometry from the params, `preview` is optional and drives the live preview
3. import your file in `src/app/docCommands.ts` and add a command in `src/app/commands.ts` so it shows up in the ribbon, menus and command palette
4. write a unit test or an e2e spec for it

## tests

all of these have to pass before a PR gets merged (CI runs them):

```
pnpm build          # typecheck + build
pnpm test           # unit tests
pnpm exec playwright test   # browser tests, takes a while
```

the browser tests fail on any console error, so keep the console clean. if you only touched one area, running just the relevant spec while you work is fine, e.g. `pnpm exec playwright test e2e/02-box.spec.ts`.

the big mesh spec (`e2e/33-big-mesh.spec.ts`) builds a production bundle with the debug handle switched on (`VITE_E2E=1`, into `dist-e2e`) and serves it with `vite preview`, because it measures main thread tasks and frame times and react's development build would swamp those. it makes a 150 MB stl in your temp folder the first time. run it with the cpu throttle off.

`scripts/slice-check.mjs` (hair) and `scripts/slice-check-print.mjs` (the print 3MF) need a local OrcaSlicer, so they aren't part of CI. run them yourself if you touch export code.

## style

keep PRs small and say what you changed in a couple of lines. no new network requests, the whole point is that nothing leaves your machine.
