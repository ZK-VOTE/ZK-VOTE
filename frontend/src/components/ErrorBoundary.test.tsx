import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ErrorBoundary, RouteErrorBoundary } from "./ErrorBoundary";

// Suppress console.error from React's error boundary logging and our componentDidCatch
const originalConsoleError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});

afterEach(() => {
  console.error = originalConsoleError;
});

// A component that throws an error when rendered
function ThrowingComponent({ message }: { message: string }): never {
  throw new Error(message);
}

// A component that renders normally
function NormalComponent() {
  return <div>Normal content</div>;
}

describe("ErrorBoundary", () => {
  describe("Normal rendering", () => {
    it("renders children when no error occurs", () => {
      render(
        <ErrorBoundary>
          <NormalComponent />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Normal content")).toBeInTheDocument();
    });

    it("renders multiple children when no error occurs", () => {
      render(
        <ErrorBoundary>
          <div>Child one</div>
          <div>Child two</div>
        </ErrorBoundary>,
      );

      expect(screen.getByText("Child one")).toBeInTheDocument();
      expect(screen.getByText("Child two")).toBeInTheDocument();
    });
  });

  describe("Error handling", () => {
    it("shows error UI when a child throws", () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent message="Test error" />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Something went wrong")).toBeInTheDocument();
      expect(
        screen.getByText("An unexpected error occurred. Please try again."),
      ).toBeInTheDocument();
    });

    it("shows Try Again button in error state", () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent message="Test error" />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Try Again")).toBeInTheDocument();
    });

    it("shows Reload Page button in error state", () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent message="Test error" />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Reload Page")).toBeInTheDocument();
    });

    it("calls console.error when an error is caught", () => {
      render(
        <ErrorBoundary>
          <ThrowingComponent message="Logged error" />
        </ErrorBoundary>,
      );

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe("Custom fallback", () => {
    it("renders custom fallback when provided and error occurs", () => {
      render(
        <ErrorBoundary fallback={<div>Custom error fallback</div>}>
          <ThrowingComponent message="Test error" />
        </ErrorBoundary>,
      );

      expect(screen.getByText("Custom error fallback")).toBeInTheDocument();
      expect(
        screen.queryByText("Something went wrong"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Try Again button", () => {
    it("resets error state when Try Again is clicked", () => {
      // We need a component that can conditionally throw
      let shouldThrow = true;

      function ConditionalThrower() {
        if (shouldThrow) {
          throw new Error("Conditional error");
        }
        return <div>Recovered content</div>;
      }

      render(
        <ErrorBoundary>
          <ConditionalThrower />
        </ErrorBoundary>,
      );

      // Should be in error state
      expect(screen.getByText("Something went wrong")).toBeInTheDocument();

      // Fix the error condition
      shouldThrow = false;

      // Click Try Again
      fireEvent.click(screen.getByText("Try Again"));

      // Should re-render children successfully
      expect(screen.getByText("Recovered content")).toBeInTheDocument();
      expect(
        screen.queryByText("Something went wrong"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Reload Page button", () => {
    it("calls window.location.reload when Reload Page is clicked", () => {
      // Mock window.location.reload
      const mockReload = vi.fn();
      Object.defineProperty(window, "location", {
        value: { ...window.location, reload: mockReload },
        writable: true,
      });

      render(
        <ErrorBoundary>
          <ThrowingComponent message="Test error" />
        </ErrorBoundary>,
      );

      fireEvent.click(screen.getByText("Reload Page"));

      expect(mockReload).toHaveBeenCalled();
    });
  });
});

describe("RouteErrorBoundary", () => {
  it("renders children when no error occurs", () => {
    render(
      <RouteErrorBoundary>
        <div>Route content</div>
      </RouteErrorBoundary>,
    );

    expect(screen.getByText("Route content")).toBeInTheDocument();
  });

  it("shows route-specific error fallback when child throws", () => {
    render(
      <RouteErrorBoundary>
        <ThrowingComponent message="Route error" />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText("Page Error")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This page encountered an error. Try navigating back or refreshing.",
      ),
    ).toBeInTheDocument();
  });

  it("shows Go Back button in route error fallback", () => {
    render(
      <RouteErrorBoundary>
        <ThrowingComponent message="Route error" />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText("Go Back")).toBeInTheDocument();
  });

  it("shows Reload button in route error fallback", () => {
    render(
      <RouteErrorBoundary>
        <ThrowingComponent message="Route error" />
      </RouteErrorBoundary>,
    );

    expect(screen.getByText("Reload")).toBeInTheDocument();
  });

  it("calls window.history.back when Go Back is clicked", () => {
    const mockBack = vi.fn();
    Object.defineProperty(window, "history", {
      value: { ...window.history, back: mockBack },
      writable: true,
    });

    render(
      <RouteErrorBoundary>
        <ThrowingComponent message="Route error" />
      </RouteErrorBoundary>,
    );

    fireEvent.click(screen.getByText("Go Back"));

    expect(mockBack).toHaveBeenCalled();
  });
});
