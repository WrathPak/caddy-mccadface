// The calls a plugin can make to the host, and which of them need a permission. The sandbox runtime builds `caddy` from this list and
// the host (host.ts) must answer every entry; a unit test keeps the two, and caddy-api.d.ts, in step.

export const METHODS = [
  'document.info', 'document.features', 'document.bodies', 'document.userParams',
  'document.addFeature', 'document.updateFeature', 'document.removeFeature',
  'document.subscribe', 'document.unsubscribe',
  'selection.get', 'selection.set', 'selection.subscribe', 'selection.unsubscribe',
  'kernel.box', 'kernel.cylinder', 'kernel.sphere', 'kernel.extrude', 'kernel.boolean', 'kernel.transform', 'kernel.toMesh', 'kernel.triangles',
  'kernel.mesh.fromTriangles', 'kernel.mesh.boolean', 'kernel.mesh.booleanMany',
  'commands.run',
  'io.download',
  'ui.toast',
]

/** Method -> the permission a plugin needs (the others are always allowed). */
export const NEEDS = {
  'document.addFeature': 'document:write',
  'document.updateFeature': 'document:write',
  'document.removeFeature': 'document:write',
  'commands.run': 'commands:run',
  'io.download': 'download',
}

export const PERMISSIONS = ['document:write', 'commands:run', 'download']

export const API_VERSION = '1'
