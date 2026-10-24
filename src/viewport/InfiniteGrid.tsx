import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, MathUtils, type OrthographicCamera, type PerspectiveCamera, type ShaderMaterial } from 'three'
import { GRID_GLSL, gridFadeRange, gridLevels } from './gridMath'
import { useVpColors } from './colors'

// The quad is positioned in the shader (centred under the camera, `uHalf` wide), so it can be as large as the far plane. It is
// cut into cells so the interpolated world position stays precise out to the edge.
const vert = /* glsl */ `
varying vec2 vRel;
uniform float uHalf;
uniform vec2 uCenter;
void main() {
  vRel = position.xy * uHalf;
  gl_Position = projectionMatrix * viewMatrix * vec4(vRel + uCenter, 0.0, 1.0);
}`

const frag = /* glsl */ `
varying vec2 vRel;
uniform float uStep;
uniform float uBlend;
uniform vec2 uCenter;
uniform float uRadius;
uniform float uOrtho;
uniform float uFadeA;
uniform float uFadeB;
uniform float uNear;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uAxisX;
uniform vec3 uAxisY;
${GRID_GLSL}
void main() {
  vec2 p = vRel + uCenter;
  // distance from the camera (depth for an orthographic one) fades the grid to the background before the far plane can clip it
  float d = uOrtho > 0.5 ? -(viewMatrix * vec4(p, 0.0, 1.0)).z : distance(vec3(p, 0.0), cameraPosition);
  float f = 1.0 - smoothstep(uFadeA, uFadeB, d);
  f *= 1.0 - smoothstep(uRadius * 0.3, uRadius, length(vRel));
  if (uOrtho < 0.5) f *= smoothstep(uNear, uNear * 2.0, d); // dissolve instead of being cut by the near plane
  float k = gridStrength(p, uStep, uBlend, f);
  vec3 col = gridColor(k, uMinor, uMajor);
  float a = 0.8 * k;
  vec2 ad = fwidth(p) * 1.2;
  float ax = 1.0 - min(abs(p.y) / max(ad.y, 1e-6), 1.0); // X axis (y = 0)
  float ay = 1.0 - min(abs(p.x) / max(ad.x, 1e-6), 1.0); // Y axis (x = 0)
  if (ax > 0.0) { col = uAxisX; a = max(a, ax * 0.9 * f); }
  if (ay > 0.0) { col = uAxisY; a = max(a, ay * 0.9 * f); }
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`

/**
 * Infinite fading grid on the XY plane (Z up). Cell size adapts to zoom in decades. The quad reaches the camera far plane (which
 * follows the scene size and the camera distance) and the shader fades the lines out with distance, so there is no plane edge at
 * any angle: the minor lines go first, then the major ones, and cells smaller than a few pixels vanish instead of moire-ing.
 */
export function InfiniteGrid() {
  const colors = useVpColors()
  const mat = useRef<ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uStep: { value: 10 },
      uBlend: { value: 0 },
      uHalf: { value: 1000 },
      uCenter: { value: [0, 0] },
      uRadius: { value: 1e9 },
      uOrtho: { value: 0 },
      uFadeA: { value: 100 },
      uFadeB: { value: 1000 },
      uNear: { value: 0.1 },
      uMinor: { value: new Color() },
      uMajor: { value: new Color() },
      uAxisX: { value: new Color() },
      uAxisY: { value: new Color() },
    }),
    [],
  )

  useFrame((state) => {
    const u = mat.current?.uniforms
    if (!u) return
    u.uMinor.value.set(colors.grid)
    u.uMajor.value.set(colors.gridMajor)
    u.uAxisX.value.set(colors.axisX)
    u.uAxisY.value.set(colors.axisY)
    const cam = state.camera as PerspectiveCamera & OrthographicCamera
    const ortho = !!cam.isOrthographicCamera
    const d = cam.position.length() || 100
    const wpp = ortho ? 1 / cam.zoom : (2 * d * Math.tan(MathUtils.degToRad(cam.fov) / 2)) / state.size.height
    const { step, blend } = gridLevels(wpp)
    u.uStep.value = step
    u.uBlend.value = blend
    const far = cam.far || 50000
    const range = gridFadeRange(far, ortho)
    u.uFadeA.value = range.start
    u.uFadeB.value = range.end
    u.uOrtho.value = ortho ? 1 : 0
    u.uNear.value = cam.near > 0 ? cam.near : 0.1
    // the lines are fixed to the world origin (multiples of the step); the quad follows the camera and always reaches the fade end
    const screen = wpp * Math.max(state.size.width, state.size.height) * 3
    u.uHalf.value = ortho ? screen * 1.1 : far
    u.uRadius.value = ortho ? screen : 1e9
    u.uCenter.value = [cam.position.x, cam.position.y]
  })

  return (
    <mesh raycast={() => null} renderOrder={-1} frustumCulled={false}>
      <planeGeometry args={[2, 2, 32, 32]} />
      <shaderMaterial
        ref={mat}
        vertexShader={vert}
        fragmentShader={frag}
        uniforms={uniforms as never as ShaderMaterial['uniforms']}
        transparent
        depthWrite={false}
        side={DoubleSide}
        extensions={{ derivatives: true } as never}
      />
    </mesh>
  )
}
