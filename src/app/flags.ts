/**
 * The debug handle (`window.__caddy`, the nav probe) exists in dev builds and in the special e2e build (`VITE_E2E=1`, used by
 * the big-mesh performance spec so it measures a real production bundle). It is never part of a released build.
 */
export const DEBUG_HANDLE = import.meta.env.DEV || import.meta.env.VITE_E2E === '1'
