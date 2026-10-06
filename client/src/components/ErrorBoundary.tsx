import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCw, RotateCcw, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * When this value changes, the boundary resets its error state automatically.
   * Pass the current route/location to reset on navigation so a broken page
   * does not stay broken after the user navigates elsewhere.
   */
  resetKey?: string | number;
  /**
   * Optional label describing the boundary scope (e.g. "page", "app"),
   * used only for context in the dev console log.
   */
  scopeLabel?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
  detailsOpen: boolean;
}

const INITIAL_STATE: ErrorBoundaryState = {
  error: null,
  detailsOpen: false,
};

/**
 * Dependency-free React error boundary.
 *
 * Catches render/lifecycle exceptions in its subtree and shows a designed
 * fallback instead of unmounting the whole SPA to a blank page. Supports two
 * recovery paths: "Try again" (reset state in place) and "Reload page".
 * When `resetKey` changes (e.g. on route navigation), the boundary clears any
 * prior error so a broken route does not persist across navigation.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = INITIAL_STATE;

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    // Reset the boundary when the reset key changes (e.g. route navigation)
    // so a previously thrown route does not stay in the error state.
    if (
      this.state.error !== null &&
      prevProps.resetKey !== this.props.resetKey
    ) {
      this.setState(INITIAL_STATE);
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const scope = this.props.scopeLabel ?? "unknown";
    // Log detailed context for diagnosis. Surfaces in the browser console and
    // any console-forwarding error reporter; intentionally not user-facing.
    // eslint-disable-next-line no-console
    console.error(
      `[ErrorBoundary:${scope}] Render error caught:`,
      error,
      info.componentStack,
    );
  }

  private handleReset = (): void => {
    this.setState(INITIAL_STATE);
  };

  private handleReload = (): void => {
    if (typeof window !== "undefined") {
      window.location.reload();
    }
  };

  private toggleDetails = (open: boolean): void => {
    this.setState((prev) => ({ ...prev, detailsOpen: open }));
  };

  render(): ReactNode {
    const { error, detailsOpen } = this.state;

    if (error === null) {
      return this.props.children;
    }

    const message = error.message || "An unexpected error occurred.";

    return (
      <div
        role="alert"
        className="flex min-h-[60vh] w-full items-center justify-center p-6"
      >
        <div className="w-full max-w-md rounded-xl border bg-card p-8 text-card-foreground shadow-sm">
          <div className="flex flex-col items-center text-center">
            <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-destructive/10 text-destructive">
              <AlertTriangle className="h-7 w-7" aria-hidden="true" />
            </div>

            <h2 className="text-lg font-semibold tracking-tight">
              Something went wrong
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              This part of the page ran into an unexpected error. You can try
              again, or reload the page if the problem persists.
            </p>

            <div className="mt-6 flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
              <Button onClick={this.handleReset} variant="default">
                <RotateCcw className="h-4 w-4" aria-hidden="true" />
                Try again
              </Button>
              <Button onClick={this.handleReload} variant="outline">
                <RefreshCw className="h-4 w-4" aria-hidden="true" />
                Reload page
              </Button>
            </div>

            <Collapsible
              open={detailsOpen}
              onOpenChange={this.toggleDetails}
              className="mt-6 w-full"
            >
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  {detailsOpen ? "Hide details" : "Show details"}
                  <ChevronDown
                    className={cn(
                      "h-3.5 w-3.5 transition-transform",
                      detailsOpen && "rotate-180",
                    )}
                    aria-hidden="true"
                  />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-3 max-h-48 overflow-auto rounded-md border bg-muted/40 p-3 text-left text-xs leading-relaxed text-muted-foreground">
                  <code className="break-words whitespace-pre-wrap">
                    {message}
                  </code>
                </pre>
              </CollapsibleContent>
            </Collapsible>
          </div>
        </div>
      </div>
    );
  }
}
