/** State of the CADdy Link connection: whether the helper is there, the printers it keeps, their live status and the file being sent. */
import { create } from 'zustand'
import type { Discovered, ErrorCode, PrinterInfo, PrinterStatus, SendStage } from './protocol'

export type LinkConn = 'off' | 'connecting' | 'pairing' | 'ready' | 'blocked'

export interface SendJob {
  jobId: string
  printerId: string
  fileName: string
  stage: SendStage
  sent: number
  total: number
  code?: ErrorCode
  message?: string
}

export interface LinkState {
  conn: LinkConn
  /** a helper was found but speaks another protocol version */
  versionError: string | null
  mock: boolean
  helper: string
  printers: PrinterInfo[]
  statuses: Record<string, PrinterStatus>
  discovered: Discovered[] | null
  discovering: boolean
  send: SendJob | null
  panelOpen: boolean
  sendOpen: boolean
  /** the pairing code was wrong */
  pairError: string | null
  set: (p: Partial<LinkState>) => void
}

export const useLink = create<LinkState>((set) => ({
  conn: 'off',
  versionError: null,
  mock: false,
  helper: '',
  printers: [],
  statuses: {},
  discovered: null,
  discovering: false,
  send: null,
  panelOpen: false,
  sendOpen: false,
  pairError: null,
  set: (p) => set(p),
}))
