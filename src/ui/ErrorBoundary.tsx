import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Warning } from '@phosphor-icons/react'

interface Props { name: string; children: ReactNode }
interface State { error: Error | null; epoch: number }

/** Contains a render error to one panel and offers to re-mount it. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, epoch: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.name}] panel crashed`, error, info.componentStack)
  }

  render() {
    const { error, epoch } = this.state
    if (!error) return <div key={epoch} style={{ display: 'contents' }}>{this.props.children}</div>
    return (
      <div className="panel-error" role="alert">
        <Warning size={14} weight="fill" />
        <div className="msg">
          <strong>{this.props.name} failed</strong>
          <span title={error.message}>{error.message}</span>
        </div>
        <button type="button" className="btn" onClick={() => this.setState((s) => ({ error: null, epoch: s.epoch + 1 }))}>
          Reload panel
        </button>
      </div>
    )
  }
}
