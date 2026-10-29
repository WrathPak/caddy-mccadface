import * as D from '@radix-ui/react-dropdown-menu'
import { BookOpen, Compass, Info, Keyboard, Question, Sparkle } from '@phosphor-icons/react'
import { RIBBON_TABS } from '@/app/ribbon'
import { useUi } from '@/store/ui'
import { Tip } from '@/ui/Tooltip'
import { guideById } from './guides'
import { openGuide, useHelp } from './helpStore'

/** The ? at the top right of the ribbon: Getting started, shortcuts, the guide of the current workspace, the tour and About. */
export function HelpMenu() {
  const show = useHelp((s) => s.show)
  const startTour = useHelp((s) => s.startTour)
  const workspace = useUi((s) => s.workspace)
  const sketchMode = useUi((s) => s.sketchMode)
  const current = sketchMode ? 'sketch' : workspace
  const guide = guideById(current) ?? guideById('solid')!
  const tab = RIBBON_TABS.find((t) => t.id === guide.id)
  return (
    <D.Root>
      <Tip label="Help" desc="Getting started, keyboard shortcuts, a guide for each workspace and a replay of the intro tour." side="bottom">
        <D.Trigger asChild>
          <button type="button" className="rbtn small" aria-label="Help" data-testid="help-menu" style={{ minWidth: 0, padding: '1px 5px' }}>
            <Question size={13} />
          </button>
        </D.Trigger>
      </Tip>
      <D.Portal>
        <D.Content className="menu" sideOffset={2} align="end" data-testid="help-menu-content">
          <D.Item className="menu-item" onSelect={() => show({ kind: 'start' })}><Compass size={14} /> Getting started</D.Item>
          <D.Item className="menu-item" onSelect={() => show({ kind: 'shortcuts' })}><Keyboard size={14} /> Keyboard shortcuts</D.Item>
          <D.Item className="menu-item" onSelect={() => openGuide(guide.id)}><BookOpen size={14} /> {tab?.label ?? guide.title} guide</D.Item>
          <D.Item className="menu-item" onSelect={() => openGuide('solid')}><BookOpen size={14} /> All workspace guides</D.Item>
          <D.Separator className="menu-sep" />
          <D.Item className="menu-item" onSelect={startTour}><Sparkle size={14} /> Take the tour</D.Item>
          <D.Item className="menu-item" onSelect={() => show({ kind: 'about' })}><Info size={14} /> About</D.Item>
        </D.Content>
      </D.Portal>
    </D.Root>
  )
}
