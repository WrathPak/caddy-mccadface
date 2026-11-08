import { describe, expect, it } from 'vitest'
import { autoMap, defaultPrinter, etaText, mappingArray, modelMatches, sameType, type Need } from './logic'
import type { PrinterInfo, Tray } from './protocol'

const tray = (id: number, type: string, color: string | null, empty = false): Tray => ({ id, slot: id % 4, type, color, remain: 80, name: '', empty })
const printer = (id: string, modelLabel: string): PrinterInfo => ({ id, name: id, model: '', modelName: '', modelLabel, serial: '', ip: '', pinned: true, storage: false, mock: false })

describe('printer link logic', () => {
  it('matches the machine preset to the model without mixing A1 and A1 mini', () => {
    expect(modelMatches({ modelLabel: 'Bambu Lab A1' }, 'Bambu Lab A1 0.4 nozzle')).toBe(true)
    expect(modelMatches({ modelLabel: 'Bambu Lab A1' }, 'Bambu Lab A1 mini 0.4 nozzle')).toBe(false)
    expect(defaultPrinter([printer('a', 'Bambu Lab P1S'), printer('b', 'Bambu Lab A1')], 'Bambu Lab A1 0.4 nozzle')?.id).toBe('b')
    expect(defaultPrinter([printer('a', 'Bambu Lab P1S')], 'Bambu Lab A1 0.4 nozzle')?.id).toBe('a')
  })
  it('treats PLA variants as one family', () => {
    expect(sameType('PLA', 'PLA-CF')).toBe(true)
    expect(sameType('PLA', 'PETG')).toBe(false)
    expect(sameType('', 'PLA')).toBe(false)
  })
  it('matches by type, then nearest color, and uses each tray once', () => {
    const trays = [tray(0, 'PLA', '#FF0000'), tray(1, 'PLA', '#FFFFFF'), tray(2, 'PETG', '#0000FF'), tray(3, 'PLA', '#000000', true)]
    const needs: Need[] = [{ slot: 1, color: '#EE2222', type: 'PLA' }, { slot: 2, color: '#F0F0F0', type: 'PLA' }, { slot: 3, color: '#2222EE', type: 'PETG' }]
    expect(autoMap(needs, trays)).toEqual({ 1: 0, 2: 1, 3: 2 })
    // a third red filament reuses a tray only when every other one of the type is taken
    expect(autoMap([{ slot: 1, color: '#FF0000', type: 'PLA' }, { slot: 2, color: '#FF0000', type: 'PLA' }, { slot: 3, color: '#FF0000', type: 'PLA' }], trays)).toEqual({ 1: 0, 2: 1, 3: 0 })
  })
  it('falls back to the external spool and builds the mapping array', () => {
    expect(autoMap([{ slot: 2, color: '#FF0000', type: 'PLA' }], [tray(254, 'PLA', '#FF0000')])).toEqual({ 2: 254 })
    expect(mappingArray({ 2: 5 }, [{ slot: 2, color: '#000000', type: 'PLA' }])).toEqual([-1, 5])
  })
  it('gives an end time', () => {
    expect(etaText(0)).toBe('')
    expect(etaText(30, 0)).not.toBe('')
  })
})
