import { describe, expect, it } from 'vitest'
import { installHow } from './install'

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  firefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0',
  firefoxAndroid: 'Mozilla/5.0 (Android 14; Mobile; rv:132.0) Gecko/132.0 Firefox/132.0',
}

describe('installHow', () => {
  it('points each browser at its own install menu', () => {
    expect(installHow(UA.iphone)).toMatch(/Add to Home Screen/)
    expect(installHow(UA.safariMac)).toMatch(/Add to Dock/)
    expect(installHow(UA.edge)).toMatch(/Edge menu/)
    expect(installHow(UA.chrome)).toMatch(/address bar/)
    expect(installHow(UA.firefoxAndroid)).toMatch(/Firefox menu/)
  })
  it('desktop Firefox cannot install web apps', () => {
    expect(installHow(UA.firefox)).toBeNull()
  })
})
