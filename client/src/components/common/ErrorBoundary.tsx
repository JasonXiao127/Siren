import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Last-resort crash boundary for the renderer. A render exception anywhere
 * below this point would otherwise blank the entire window with no recovery;
 * the fallback offers a reload instead of a silent white screen. Login state
 * and settings survive (localStorage + server-side session are untouched).
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[siren] Renderer crashed:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-background p-8 text-center">
        <h1 className="text-xl font-bold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Siren's interface hit an unexpected error. Reloading usually fixes
          it — your login and settings are kept.
        </p>
        <Button onClick={() => window.location.reload()}>Reload Siren</Button>
      </div>
    );
  }
}
