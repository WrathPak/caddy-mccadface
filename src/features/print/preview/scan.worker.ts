/** Scans a G-code file off the main thread (tens of MB on a big plate). */
import { expose } from 'comlink'
import { scanGcode } from './gcodeFilaments'

expose({ scan: (gcode: Uint8Array) => scanGcode(gcode) })
