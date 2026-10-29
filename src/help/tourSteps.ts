/** The intro tour: seven short steps over the parts of the screen. The first step has no target and sits in the middle. */
export interface TourStep {
  id: string
  /** CSS selector of the part of the screen to point at */
  target?: string
  title: string
  body: string
  /** where the card prefers to sit relative to the target on a wide screen */
  side?: 'left' | 'right' | 'top' | 'bottom'
}

export const TOUR: TourStep[] = [
  {
    id: 'welcome',
    title: 'Welcome to CADdy McCADFace',
    body: 'This is a CAD program that runs entirely in your browser: nothing is uploaded and there is no account. A quick look around takes about a minute. You can skip it now and replay it any time from the ? menu.',
  },
  {
    id: 'ribbon',
    target: '.ribbon',
    side: 'bottom',
    title: 'The ribbon',
    body: 'Your tools live here, grouped into workspaces: Solid for parts, Surface for curved skins, Mesh for STL files, Hair, Print and more. Click a tab to switch. Hover any button to see what it does.',
  },
  {
    id: 'browser',
    target: '[data-tour="browser"]',
    side: 'right',
    title: 'The Browser',
    body: 'Everything in your document is listed here: bodies, sketches, planes and components. Click to select, use the eye to hide something, and double-click a name to rename it.',
  },
  {
    id: 'viewport',
    target: '.vp',
    side: 'left',
    title: 'The viewport',
    body: 'This is your model. The wheel zooms, the middle mouse button pans and Shift with it orbits (Settings has other mouse and touchpad styles). The cube in the corner snaps to standard views, and the buttons at the bottom change how things are drawn.',
  },
  {
    id: 'timeline',
    target: '.tl',
    side: 'top',
    title: 'The timeline',
    body: 'Every step you take is recorded here as a chip. Double-click one to change its numbers and everything after it rebuilds. Drag the marker back to see the model as it was earlier.',
  },
  {
    id: 'inspector',
    target: '[data-tour="inspector"]',
    side: 'left',
    title: 'The Inspector',
    body: 'When you start a tool, its settings appear here. Hover a label for a plain explanation, press Enter to accept or Esc to cancel, and use the ? at the top to open the guide for that tool.',
  },
  {
    id: 'status',
    target: '.status',
    side: 'top',
    title: 'The status bar',
    body: 'Units, snapping and what you can pick are here, plus the gear for Settings. Press S any time to search every command by name. The ? menu in the top right has guides and the shortcut list.',
  },
]
