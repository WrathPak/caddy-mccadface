import { describe, expect, it } from 'vitest'
import { isSoftwareRenderer } from './glass'

describe('isSoftwareRenderer', () => {
  it('knows the CPU rasterizers by name', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)')).toBe(true)
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true)
    expect(isSoftwareRenderer('Microsoft Basic Render Driver')).toBe(true)
  })
  it('leaves real GPUs alone', () => {
    expect(isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(false)
    expect(isSoftwareRenderer('Apple M2')).toBe(false)
    expect(isSoftwareRenderer('Mali-G78')).toBe(false)
  })
})
