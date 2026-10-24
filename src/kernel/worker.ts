/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import { api } from './api'

export type { BoolOp, BodyMeta, KernelApi } from './api'
Comlink.expose(api)
