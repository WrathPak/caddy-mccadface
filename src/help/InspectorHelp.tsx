import { Question } from '@phosphor-icons/react'
import { getCommand } from '@/app/commands'
import { useSettings } from '@/settings/settings'
import { useUi } from '@/store/ui'
import { Tip } from '@/ui/Tooltip'
import { FEATURE_GUIDE, guideById } from './guides'
import { helpFor } from './commandHelp'
import { openGuide } from './helpStore'

/** The ? in the Inspector header: opens the guide at the section that explains this tool. */
export function GuideLink({ schemaId, title }: { schemaId: string; title: string }) {
  const workspace = useUi((s) => s.workspace)
  const target = FEATURE_GUIDE[schemaId] ?? { guide: guideById(workspace) ? workspace : 'solid', section: 'flow' }
  const guide = guideById(target.guide)
  return (
    <Tip label={`Guide: ${title}`} desc={`Open the ${guide?.title ?? ''} guide at the steps for this tool.`} side="left">
      <button type="button" className="help-link" aria-label={`Open the guide for ${title}`} data-testid="inspector-help" onClick={() => openGuide(target.guide, target.section)}>
        <Question size={13} />
      </button>
    </Tip>
  )
}

/** A line under the Inspector title that says what the running tool does and what to pick (the Beginner tips setting turns it off). */
export function ToolIntro() {
  const on = useSettings((s) => s.beginnerTips)
  const tool = useUi((s) => s.activeTool)
  const cmd = tool ? getCommand(tool) : undefined
  const h = cmd ? helpFor(cmd) : undefined
  if (!on || !h) return null
  return (
    <div className="insp-intro" data-testid="tool-intro">
      {h.desc}
      {h.select && <div className="insp-intro-sel"><span>Select</span> {h.select}</div>}
    </div>
  )
}
