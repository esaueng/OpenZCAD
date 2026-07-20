import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  label: string;
  resetKey?: string | number;
}

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  override state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`${this.props.label} crashed:`, error, info.componentStack);
  }

  override componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) {
      this.setState({ failed: false });
    }
  }

  override render() {
    if (!this.state.failed) {
      return this.props.children;
    }
    return (
      <section className="error-boundary" role="alert">
        <strong>{this.props.label} could not be rendered.</strong>
        <span>Your document is still available. Reload to recover this panel.</span>
        <button type="button" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </section>
    );
  }
}
