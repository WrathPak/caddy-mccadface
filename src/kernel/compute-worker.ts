/// <reference lib="webworker" />
import * as Comlink from 'comlink'
import { computeApi } from './compute'

Comlink.expose(computeApi)
