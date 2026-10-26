# writing plugins

plugins let you add your own features, commands and ribbon buttons to caddy mccadface without touching the app. a plugin is just a javascript file (or a small folder of them) that you load from your own disk. nothing is uploaded anywhere, and the plugin runs in a sandbox, so a plugin you downloaded can't get at the page or the network.

this page is the tour. the exact types live in `caddy-api.d.ts` (more on that below), and there are two working examples in `examples/plugins/`.

## the quickest start

make a file called `hello.js`:

```js
export function activate(caddy) {
  caddy.commands.register({
    id: 'hello',
    label: 'Say hello',
    run: () => caddy.ui.toast('hello from a plugin'),
    ribbon: { tab: 'solid', group: 'Hello' },
  })
}
```

open the **Plugins** panel (the little panel icon at the right of the ribbon tabs), press **File**, pick `hello.js` and confirm. a new **Hello** group shows up on the Solid tab. click it and you get the toast. that's the whole loop.

if you just want to try the api out, the **Script** panel is quicker: type some code, press Ctrl+Enter. the `caddy` object is already there, and `console.log` shows up in the output below.

## the shape of a plugin

a plugin is an es module. it can export:

```js
export const manifest = { name: 'My plugin', version: '1.0.0', description: 'what it does', permissions: ['download'] }
export function activate(caddy) { /* register things here */ }
export function deactivate() { /* optional: tidy up */ }
```

`activate` gets the one object you use for everything, `caddy`. it can be async. when it finishes, the plugin shows as running.

### a folder instead of a file

for anything bigger, make a folder:

```
my-plugin/
  plugin.json
  index.js
  maths.js
```

`plugin.json` is optional:

```json
{
  "id": "my-plugin",
  "name": "My plugin",
  "version": "1.0.0",
  "description": "what it does",
  "main": "index.js",
  "permissions": ["download"]
}
```

`main` is the entry file (default `index.js`). the other files can be imported with relative paths:

```js
import { gearOutline } from './maths.js'
```

a few limits to know about:

- only relative imports of your own files work (`./maths.js`, `../lib/x.js`). no packages from npm and no urls. if you want a library, copy the code in.
- write imports as plain string literals. the app finds them by reading your source, so an `import` inside a string or built from pieces isn't followed.
- files must be `.js` or `.mjs`, and a plugin can be up to 200 files and 3 MB.
- no `eval` or `new Function`. the sandbox doesn't allow them.

press **Folder** in the Plugins panel and pick the folder. the app keeps a copy of the files in your browser, so the plugin starts by itself next time. to update it, add the folder again (same id replaces the old one).

## getting completion in your editor

the api is typed. the app serves the types at `/caddy-api.d.ts`, the Plugins panel has a button that downloads it, and it's in the repo at `src/api/caddy-api.d.ts`. put the file next to your plugin and start your plugin with:

```js
// @ts-check
/// <reference path="caddy-api.d.ts" />

/** @param {CaddyApi} caddy */
export function activate(caddy) {
  caddy.kernel. // <- your editor now lists box, cylinder, extrude, boolean...
}
```

`examples/plugins/tsconfig.json` shows a setup that type checks plugins with `tsc -p`. the Script panel also completes `caddy.` as you type.

## what you can do

everything goes through `caddy`. here is each part with a small example.

### features: your own entries in the timeline

a feature has a dialog (made from a list of parameters you describe) and a `compute` function that builds geometry from the values.

```js
caddy.features.register({
  type: 'peg',
  label: 'Peg',
  icon: 'cylinder',
  ribbon: { tab: 'solid', group: 'My parts' },
  params: [
    { type: 'number', key: 'radius', label: 'Radius', unit: 'mm', min: 0.5, default: 3 },
    { type: 'number', key: 'height', label: 'Height', unit: 'mm', default: 10 },
  ],
  async compute(ctx, p) {
    const peg = await ctx.kernel.cylinder({ radius: p.radius, height: p.height })
    return { bodies: [peg] }
  },
})
```

things worth knowing:

- the feature shows up in the timeline like any other. it's stored in the document as `<plugin id>.<type>`, so `my-plugin.peg`. if the plugin isn't running when you open the document, the feature shows an "unknown feature type" error until you switch the plugin on again, and then it builds.
- `compute` runs every time the timeline regenerates, so keep it a plain function of its inputs. no random numbers and no state kept between calls, or your model will change when nobody touched it.
- `ctx.bodies` are the bodies that exist before your feature. `ctx.kernel` is the same as `caddy.kernel`.
- return `{ bodies, remove, warning }`. `bodies` are what you want to add (the first gets the feature's own id, so later features can refer to it). `remove` is a list of existing body ids to delete. `warning` is a message shown on the feature when it built but something's off.
- if `compute` throws, the feature shows your error message. that's the way to say "the bore is too big".
- `ribbon` is optional. without it the feature is still in the command palette (press `S`).

the parameter types are `number`, `enum`, `bool`, `vector3`, `text`, `selection-ref` and `group`. each takes `key`, `label` and usually `default`, plus `help` text (shown as a tooltip and under the field). a field can be hidden unless another has some value: `visibleWhen: { key: 'kind', equals: 'b' }`. `caddy-api.d.ts` lists every option. if a definition is wrong, the Plugins panel shows which field and why.

a `selection-ref` field lets the user pick things in the viewport. when it accepts only bodies, `compute` gets the picked body ids, and you can find them in `ctx.bodies`.

### commands

```js
caddy.commands.register({
  id: 'count',
  label: 'Count the bodies',
  tip: 'longer text for the tooltip',
  icon: 'star',
  shortcut: 'Ctrl+Shift+K',
  ribbon: { tab: 'mesh' },
  async run() {
    const bodies = await caddy.document.bodies()
    caddy.ui.toast(`${bodies.length} bodies`)
  },
})
```

commands show up in the palette and, with `ribbon`, as a button. if a shortcut is already taken by the app, the app keeps it. you can also put one of the app's own commands on the ribbon with `caddy.ribbon.add({ command: 'view.frame', tab: 'solid', group: 'My tools' })`.

### the document and the selection

```js
const info = await caddy.document.info()          // { name, featureCount, rollback, dirty }
const features = await caddy.document.features()  // id, type, name, state, params
const bodies = await caddy.document.bodies()      // id, name, kind, triangles, bounds, handle
const params = await caddy.document.userParams()  // the named values from the Parameters dialog

caddy.document.onChange(() => console.log('something changed'))
caddy.selection.onChange((refs) => console.log('selected', refs))
```

to change the document you add, update or remove features. that needs the `document:write` permission:

```js
const id = await caddy.document.addFeature('box', { width: 20, depth: 20, height: 5, position: [0, 0, 0] }, 'Plate')
await caddy.document.updateFeature(id, { width: 30, depth: 20, height: 5, position: [0, 0, 0] })
await caddy.document.removeFeature(id)
```

`addFeature` works with any feature type the app knows, including ones from other plugins.

### geometry: `caddy.kernel`

the kernel is the same geometry engine the app uses. solids are exact (OpenCascade), meshes go through manifold. every call returns a new body and leaves its inputs alone. units are millimetres and degrees.

```js
const k = caddy.kernel
const plate = await k.box({ size: [30, 20, 5], position: [0, 0, 0] })      // position = middle of the bottom face
const hole = await k.cylinder({ radius: 4, height: 20, position: [0, 0, -5] })
const part = await k.boolean({ op: 'subtract', base: plate, tools: [hole] })
const moved = await k.transform({ body: part, translate: [50, 0, 0], rotate: [0, 0, 45] })
```

- `box`, `cylinder` (axis along +Z) and `sphere` are the basic solids.
- `extrude` makes a prism from a polygon: `{ outline: [[x, y], ...], holes: [[[x, y], ...]], height, plane: 'XY' | 'XZ' | 'YZ', origin: [x, y, z] }`. the points are in the plane's own coordinates. XZ faces towards -Y, like the origin plane in the app. this is what the gear example uses.
- `boolean` does `union`, `subtract` and `intersect`. when every input is a solid the result stays exact, otherwise it's a mesh.
- `toMesh(body)` turns a solid into a triangle mesh. `triangles(body)` gives you `{ positions: Float32Array, indices: Uint32Array }` for any body.
- `mesh.fromTriangles({ positions, indices })` makes a mesh body from your own triangles.
- `mesh.boolean` is the manifold version, and `mesh.booleanMany(jobs)` runs several independent mesh booleans side by side on the worker pool.

bodies are passed around as the objects the calls return (or just their `handle` string). handles are only good while the plugin is running, and handles you create inside `compute` are gone when it returns, so return what you want to keep.

### downloads and messages

```js
await caddy.io.download('hello.txt', 'some text')                        // needs the 'download' permission
await caddy.io.download('part.stl', bytes, 'model/stl')                  // bytes is a Uint8Array
caddy.ui.toast('done')
caddy.ui.toast('that did not work', 'error')
caddy.log.info('shows in the plugin log')
```

`console.log` also goes to the plugin's log (the **Log** button on its row in the Plugins panel).

## permissions

reading the document, building geometry, the selection, toasts and the log are always available. three things need your say-so:

| permission | what it lets the plugin do |
| --- | --- |
| `document:write` | add, update and remove features |
| `commands:run` | run any command of the app with `caddy.commands.run(id)` |
| `download` | offer files for download |

a plugin lists what it wants under `permissions` (in `plugin.json`, or in `export const manifest` for a single file). when you add a folder you see the list and can untick things. for a single file the list shows up on its row after it starts, with the boxes unticked. you can change them any time. a call without the permission fails with a message that says which one is missing.

## the sandbox

each plugin runs in its own hidden iframe (`sandbox="allow-scripts"`, so no access to the app's page, cookies or storage) with a content security policy that forbids every network request, and in it a web worker that runs your code. the only way out is a message channel the app opened, which carries the calls above. in practice that means:

- no `document`, `window`, `localStorage` or `indexedDB`.
- no `fetch`, `XMLHttpRequest`, `WebSocket` or importing from a url. the app removes them, and the policy blocks them even if something found a way round.
- a plugin that doesn't answer for a minute is stopped.

that's meant to make it safe to try a plugin from somebody else. it can still be annoying (an infinite loop, huge geometry), so switch it off in the panel if it misbehaves.

## the two examples

both are in `examples/plugins/`. add them with the Folder button.

- **gear-generator** adds a Gear feature with teeth, module, pressure angle, thickness, bore and position. it's a good model of a real plugin: `index.js` declares the dialog and calls `kernel.extrude`, `involute.js` is the tooth maths in a second file, and a bore that's too big throws a readable error.
- **export-all-stl** adds one command, "Export all bodies as STLs". it asks for the `download` permission, reads every body with `kernel.triangles`, writes binary stls and a small zip in plain javascript, and downloads it.

## when something doesn't work

- open the Plugins panel and look at the row. a plugin that failed to start shows why in red (a syntax error, a missing file, an import it isn't allowed to make).
- press **Log** on the row to see what it printed.
- a feature that fails shows the message from your `compute` in the Inspector and the timeline.
- the Script panel is a good place to poke at a call before putting it in a plugin.
- if the app says a plugin "needs the download permission", that's the checkbox on its row.

## the api version

`caddy.version` is `'1'`. it changes if something plugins rely on stops working the same way.
