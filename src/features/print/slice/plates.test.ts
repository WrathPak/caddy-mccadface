import { describe, expect, it } from 'vitest'
import { compatiblePlate, effectivePlate, modelPlates, plateId, plateProblem, unsupportedSlots } from './plates'
import { emptyProfile, parseProfile, serializeProfile } from './profile'

const petg = { cool_plate_temp: ['0'], eng_plate_temp: ['0'], hot_plate_temp: ['80'], textured_plate_temp: ['70'], supertack_plate_temp: ['0'], textured_cool_plate_temp: ['0'] }

describe('build plates', () => {
  it('reads every spelling Orca uses', () => {
    expect(plateId('Smooth Cool Plate')).toBe('Cool Plate')
    expect(plateId('Smooth PEI Plate / High Temp Plate')).toBe('High Temp Plate')
    expect(plateId('Cool Plate (SuperTack)')).toBe('Supertack Plate')
    expect(plateId('nope')).toBeNull()
  })

  it('lists the printer model plates and its default', () => {
    const x2d = modelPlates({ default_bed_type: 'Textured PEI Plate', not_support_bed_type: 'Cool Plate' })!
    expect(x2d.default).toBe('Textured PEI Plate')
    expect(x2d.supported).not.toContain('Cool Plate')
    expect(x2d.supported).toContain('Engineering Plate')
    expect(modelPlates({ not_support_bed_type: 'Cool Plate;Smooth PEI Plate / High Temp Plate' })!.supported).not.toContain('High Temp Plate')
    expect(modelPlates({})).toBeNull()
  })

  it('falls back to the default when the plate is not offered', () => {
    const mp = modelPlates({ default_bed_type: 'Textured PEI Plate', not_support_bed_type: 'Cool Plate' })!
    expect(effectivePlate('Cool Plate', mp)).toBe('Textured PEI Plate')
    expect(effectivePlate('Engineering Plate', mp)).toBe('Engineering Plate')
    expect(effectivePlate('', mp)).toBe('Textured PEI Plate')
  })

  it('finds filaments a plate cannot print and a plate that works', () => {
    const mp = modelPlates({ default_bed_type: 'Textured PEI Plate' })!
    expect(unsupportedSlots([petg, {}], 'Cool Plate')).toEqual([0])
    expect(plateProblem('Cool Plate', [petg], ['Generic PETG'])).toBe("Cool Plate can't print Generic PETG. Pick another plate.")
    expect(plateProblem('Textured PEI Plate', [petg], ['Generic PETG'])).toBeNull()
    expect(compatiblePlate(mp, [petg])).toBe('Textured PEI Plate')
    expect(compatiblePlate({ ...mp, default: 'Cool Plate' }, [petg])).toBe('High Temp Plate')
  })

  it('is stored with the document profile', () => {
    const p = { ...emptyProfile(), bedType: 'Engineering Plate' }
    expect(parseProfile(serializeProfile(p))?.bedType).toBe('Engineering Plate')
    expect(parseProfile(JSON.stringify({ v: 1, machine: 'x' }))?.bedType).toBe('')
  })
})
