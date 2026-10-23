import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, MathUtils, type Mesh, type OrthographicCamera, type PerspectiveCamera, type ShaderMaterial } from 'three'
import { GRID_GLSL, gridLevels } from './gridMath'
import { useVpColors } from './colors'

const vert = /* glsl */ `
varying vec3 vPos;
void main() {
  vPos = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vPos, 1.0);
}`

const frag = /* glsl */ `
varying vec3 vPos;
uniform float uStep;
uniform float uBlend;
uniform vec2 uCenter;
uniform float uRadius;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uAxisX;
uniform vec3 uAxisY;
${GRID_GLSL}
void main() {
  vec2 p = vPos.xy;
  float k = gridStrength(p, uStep, uBlend);
  vec3 col = gridColor(k, uMinor, uMajor);
  float a = 0.8 * k;
  vec2 ad = fwidth(p) * 1.2;
  float ax = 1.0 - min(abs(p.y) / max(ad.y, 1e-6), 1.0); // X axis (y = 0)
  float ay = 1.0 - min(abs(p.x) / max(ad.x, 1e-6), 1.0); // Y axis (x = 0)
  if (ax > 0.0) { col = uAxisX; a = max(a, ax * 0.9); }
  if (ay > 0.0) { col = uAxisY; a = max(a, ay * 0.9); }
  a *= 1.0 - smoothstep(uRadius * 0.3, uRadius, length(p - uCenter));
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`

/** Infinite fading grid on the XY plane (Z up). Cell size adapts to zoom in decades. */
export function InfiniteGrid() {
  const colors = useVpColors()
  const mesh = useRef<Mesh>(null)
  const mat = useRef<ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({
      uStep: { value: 10 },
      uBlend: { value: 0 },
      uCenter: { value: [0, 0] },
      uRadius: { value: 1000 },
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
    const d = cam.position.length() || 100
    const wpp = cam.isOrthographicCamera ? 1 / cam.zoom : (2 * d * Math.tan(MathUtils.degToRad(cam.fov) / 2)) / state.size.height
    const { step, blend } = gridLevels(wpp)
    u.uStep.value = step
    u.uBlend.value = blend
    // the quad is large and follows the camera; the lines are fixed to the world origin (multiples of the step)
    const half = wpp * Math.max(state.size.width, state.size.height) * 3
    u.uRadius.value = half
    const cx = cam.position.x, cy = cam.position.y
    u.uCenter.value = [cx, cy]
    if (mesh.current) {
      mesh.current.scale.setScalar(half * 1.1)
      mesh.current.position.set(cx, cy, 0)
    }
  })

  return (
    <mesh ref={mesh} raycast={() => null} renderOrder={-1}>
      <planeGeometry args={[2, 2]} />
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
