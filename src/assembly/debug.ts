/** Dev-only handle for the e2e specs (`window.__caddy.assembly`): the assembly stores and actions, without going through the UI. */
import * as actions from './actions'
import * as check from './check'
import * as clipboard from './clipboard'
import * as exportAsm from './exportAssembly'
import * as external from './external'
import * as instances from './instances'
import * as jointDialog from './jointDialog'
import * as motion from './motion'
import * as place from './place'
import * as selection from './selection'
import * as snaps from './snaps'
import { useAssemblyRuntime } from './runtime'

export const assemblyDebug = { rt: useAssemblyRuntime, actions, check, clipboard, exportAsm, external, instances, jointDialog, motion, place, selection, snaps }
