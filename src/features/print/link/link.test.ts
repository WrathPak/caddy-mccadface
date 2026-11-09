import { describe, expect, it } from 'vitest'
import { klipperStatus, mergeStatus } from './direct'
import { autoMap, defaultPrinter, etaText, hasPresetFor, kindsForVendor, mappingArray, modelMatches, printersForVendor, sameType, type Need } from './logic'
import type { PrinterInfo, Tray } from './protocol'

const tray = (id: number, type: string, color: string | null, empty = false): Tray => ({ id, slot: id % 4, type, color, remain: 80, name: '', empty })
const printer = (id: string, modelLabel: string, kind: PrinterInfo['kind'] = 'bambu'): PrinterInfo => ({ id, name: id, kind, model: '', modelName: '', modelLabel, serial: '', ip: '', port: 0, tls: false, secret: false, pinned: true, storage: false, mock: false })

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
  it('sends a slice to the kind of printer its machine belongs to', () => {
    const list = [printer('b', 'Bambu Lab P1S'), printer('p', '', 'prusa'), printer('k', '', 'klipper'), printer('o', '', 'octoprint')]
    expect(kindsForVendor('Prusa')).toEqual(['prusa'])
    expect(printersForVendor(list, 'Prusa').map((x) => x.id)).toEqual(['p'])
    expect(printersForVendor(list, 'Creality').map((x) => x.id)).toEqual(['k', 'o'])
    expect(defaultPrinter(list, 'Bambu Lab P1S 0.4 nozzle', 'BBL')?.id).toBe('b')
    expect(defaultPrinter(list, 'Prusa MK4S 0.4 nozzle', 'Prusa')?.id).toBe('p')
    expect(defaultPrinter([printer('b', 'Bambu Lab P1S')], 'Prusa MK4S 0.4 nozzle', 'Prusa')).toBeNull()
  })
  it('knows which Bambu models have a machine preset', () => {
    const machines = ['Bambu Lab X2D 0.4 nozzle', 'Bambu Lab X1 Carbon 0.4 nozzle', 'Bambu Lab X1E 0.4 nozzle', 'Bambu Lab A1 mini 0.4 nozzle']
    expect(hasPresetFor('Bambu Lab X2D', machines)).toBe(true)
    expect(hasPresetFor('Bambu Lab X1 Carbon', machines)).toBe(true)
    expect(hasPresetFor('Bambu Lab X1', machines)).toBe(false) // X1 is not X1 Carbon or X1E
    expect(hasPresetFor('Bambu Lab H2S', machines)).toBe(false)
  })
  it('turns Moonraker objects into a printer status', () => {
    const raw = mergeStatus({}, { print_stats: { state: 'printing', filename: 'a.gcode', print_duration: 60, info: { current_layer: 4, total_layer: 20 } }, display_status: { progress: 0.25 }, extruder: { temperature: 214.6, target: 215 }, fan: { speed: 0.5 }, toolhead: { position: [1, 2, 3.2, 0] } })
    mergeStatus(raw, { print_stats: { state: 'paused' } })
    const s = klipperStatus('x', raw)
    expect(s).toMatchObject({ state: 'pause', percent: 25, layer: 4, totalLayers: 20, file: 'a.gcode', nozzle: { cur: 214.6, target: 215 }, fans: { part: 50 }, problem: null })
    expect(s.readouts).toEqual([{ label: 'Height', value: '3.20 mm' }])
    expect(klipperStatus('x', { print_stats: { state: 'printing', print_duration: 60 }, display_status: { progress: 0.25 } }).remainingMin).toBe(3)
    expect(klipperStatus('x', raw, 'shutdown').problem?.code).toBe('not_ready')
  })
})
