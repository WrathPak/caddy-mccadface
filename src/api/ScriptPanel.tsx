import { useEffect, useRef } from 'react'
import { Play, Stop, Eraser } from '@phosphor-icons/react'
import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { javascript } from '@codemirror/lang-javascript'
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete'
import { HighlightStyle, bracketMatching, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'
import { caddyCompletions, kernelCompletions } from './completions'
import { runScript, stopScript, useScript } from './scriptRunner'
import '@/app/platform.css'

const KEY = 'caddy-script'

export const STARTER = `// A quick script. It runs in a sandbox with the whole API in \`caddy\`. Press Ctrl+Enter to run it.
const info = await caddy.document.info()
console.log('Document:', info.name, '-', info.featureCount, 'features')

// geometry from the kernel: a plate with a hole through it
const plate = await caddy.kernel.box({ size: [30, 20, 5], position: [0, 0, 0] })
const hole = await caddy.kernel.cylinder({ radius: 4, height: 20, position: [0, 0, -5] })
const part = await caddy.kernel.boolean({ op: 'subtract', base: plate, tools: [hole] })
console.log('A plate with a hole in it:', part.triangles, 'triangles, from', part.bounds.min, 'to', part.bounds.max)

// put something in the document with a built-in feature
await caddy.document.addFeature('box', { width: 30, depth: 20, height: 5, position: [0, 0, 0] }, 'Plate')
`

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword], color: '#c792ea' },
  { tag: [t.string, t.special(t.string)], color: '#a5d6a0' },
  { tag: [t.number, t.bool, t.null], color: '#f0a875' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: '#6d7480', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: '#82aaff' },
  { tag: [t.propertyName], color: '#9ccfd8' },
  { tag: [t.definition(t.variableName)], color: '#e0e3e8' },
  { tag: [t.operator, t.punctuation], color: '#9096a0' },
])

const read = () => { try { return localStorage.getItem(KEY) } catch { return null } }
const write = (v: string) => { try { localStorage.setItem(KEY, v) } catch { /* it just does not stay */ } }

export function ScriptPanel() {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const { lines, running, clear } = useScript()
  const out = useRef<HTMLDivElement>(null)

  const run = () => { const v = view.current; if (v) { write(v.state.doc.toString()); void runScript(v.state.doc.toString()) } }
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    const view_ = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: read() ?? STARTER,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), history(), drawSelection(), indentOnInput(), bracketMatching(), closeBrackets(), highlightActiveLine(),
          javascript(),
          syntaxHighlighting(highlight),
          autocompletion({ override: [caddyCompletions, kernelCompletions], icons: false }),
          keymap.of([
            { key: 'Mod-Enter', run: () => { runRef.current(); return true } },
            ...closeBracketsKeymap, ...completionKeymap, ...historyKeymap, ...defaultKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((u) => { if (u.docChanged) write(u.state.doc.toString()) }),
          EditorView.contentAttributes.of({ 'aria-label': 'Script', spellcheck: 'false' }),
        ],
      }),
    })
    view.current = view_
    return () => { view_.destroy(); view.current = null }
  }, [])

  useEffect(() => { out.current?.scrollTo({ top: out.current.scrollHeight }) }, [lines])

  return (
    <div className="pf-panel script-panel" data-testid="script-panel" onKeyDown={(e) => e.stopPropagation()}>
      <div className="pf-head">
        <span className="pf-sub grow">Runs in a sandbox. Ctrl+Enter runs it.</span>
        <button type="button" className="btn primary" onClick={run} title="Run (Ctrl+Enter)"><Play size={12} weight="fill" /> Run</button>
        <button type="button" className="btn" onClick={stopScript} disabled={!running} title="Stop it and take back what it registered"><Stop size={12} weight="fill" /> Stop</button>
        <button type="button" className="btn" onClick={() => { const v = view.current; if (v) v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: STARTER } }) }} title="Put the example script back">Example</button>
      </div>
      <div className="cm-host" ref={host} data-testid="script-editor" />
      <div className="pf-head" style={{ borderTop: '1px solid var(--line)', borderBottom: 'none', padding: '2px 8px' }}>
        <span className="pf-sub grow">Output</span>
        <button type="button" className="btn" style={{ height: 18 }} onClick={clear} aria-label="Clear output"><Eraser size={11} /></button>
      </div>
      <div className="script-console" ref={out} data-testid="script-output" role="log">
        {lines.length === 0 && <div className="ln info">console.log and errors show up here.</div>}
        {lines.map((l, i) => <div key={i} className={'ln ' + l.level}>{l.text}</div>)}
      </div>
    </div>
  )
}
