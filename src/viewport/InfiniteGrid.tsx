import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Color, DoubleSide, type Mesh, type ShaderMaterial } from 'three'
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
uniform vec2 uCenter;
uniform float uRadius;
uniform vec3 uMinor;
uniform vec3 uMajor;
uniform vec3 uAxisX;
uniform vec3 uAxisY;
float lines(vec2 p, float size) {
  vec2 q = p / size;
  vec2 d = fwidth(q);
  vec2 g = abs(fract(q - 0.5) - 0.5) / max(d, vec2(1e-6));
  return 1.0 - min(min(g.x, g.y), 1.0);
}
void main() {
  vec2 p = vPos.xy;
  float minor = lines(p, uStep);
  float major = lines(p, uStep * 10.0);
  vec2 ad = fwidth(p) * 1.2;
  float ax = 1.0 - min(abs(p.y) / max(ad.y, 1e-6), 1.0); // X axis (y = 0)
  float ay = 1.0 - min(abs(p.x) / max(ad.x, 1e-6), 1.0); // Y axis (x = 0)
  vec3 col = uMinor;
  float a = minor * 0.35;
  if (major > 0.0) { col = uMajor; a = max(a, major * 0.6); }
  if (ax > 0.0) { col = uAxisX; a = max(a, ax * 0.9); }
  if (ay > 0.0) { col = uAxisY; a = max(a, ay * 0.9); }
  float fade = 1.0 - smoothstep(uRadius * 0.25, uRadius, length(p - uCenter));
  a *= fade;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col, a);
}`

/** Infinite fading grid on the XY plane (Z up). Cell size adapts to zoom in decades. */
export function InfiniteGrid() {
  const colors = useVpColors()
  const mesh = useRef<Mesh>(null)
  const uniforms = useMemo(
    () => ({
      uStep: { value: 10 },
      uCenter: { value: [0, 0] },
      uRadius: { value: 1000 },
      uMinor: { value: new Color() },
      uMajor: { value: new Color() },
      uAxisX: { value: new Color() },
      uAxisY: { value: new Color() },
    }),
    [],
  )
  uniforms.uMinor.value.set(colors.grid)
  uniforms.uMajor.value.set(colors.gridMajor)
  uniforms.uAxisX.value.set(colors.axisX)
  uniforms.uAxisY.value.set(colors.axisY)

  useFrame((state) => {
    const cam = state.camera
    const d = cam.position.length() || 100
    const step = Math.pow(10, Math.floor(Math.log10(d / 8)))
    uniforms.uStep.value = step
    uniforms.uRadius.value = step * 120
    const q = step * 10
    const cx = Math.round(cam.position.x / q) * q
    const cy = Math.round(cam.position.y / q) * q
    uniforms.uCenter.value = [cx, cy]
    if (mesh.current) {
      mesh.current.scale.setScalar(step * 250)
      mesh.current.position.set(cx, cy, 0)
    }
  })

  return (
    <mesh ref={mesh} raycast={() => null} renderOrder={-1}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
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
