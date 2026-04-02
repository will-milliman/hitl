import React from "react";
import styled from "styled-components";
import { trpc } from "../../trpc/client";

const StyledLink = styled.a`
  color: ${({ theme }) => theme.colors.blue};
  text-decoration: none;
  cursor: pointer;

  &:hover {
    color: ${({ theme }) => theme.colors.sapphire};
    text-decoration: underline;
  }
`;

const StyledSelect = styled.select`
  background: ${({ theme }) => theme.colors.surface0};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.surface1};
  padding: 4px 8px;
  font-size: 12px;
  font-family: ${({ theme }) => theme.fonts.sans};
  cursor: pointer;

  &:hover {
    border-color: ${({ theme }) => theme.colors.surface2};
  }

  &:focus {
    outline: none;
    border-color: ${({ theme }) => theme.colors.mauve};
  }

  option {
    background: ${({ theme }) => theme.colors.surface0};
    color: ${({ theme }) => theme.colors.text};
  }
`;

export const StyledCheckbox = styled.input`
  appearance: none;
  -webkit-appearance: none;
  cursor: pointer;
  width: 16px;
  height: 16px;
  border: 1px solid ${({ theme }) => theme.colors.overlay0};
  background: ${({ theme }) => theme.colors.surface1};
  position: relative;

  &:checked {
    background: ${({ theme }) => theme.colors.green};
    border-color: ${({ theme }) => theme.colors.green};
  }

  &:checked::after {
    content: "";
    position: absolute;
    left: 4px;
    top: 1px;
    width: 4px;
    height: 8px;
    border: solid ${({ theme }) => theme.colors.base};
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
`;

const PlaceholderText = styled.span`
  opacity: 0.5;
`;

interface ExternalLinkProps {
  href: string;
  children: React.ReactNode;
}

export function ExternalLink({ href, children }: ExternalLinkProps) {
  const openExternal = trpc.openExternal.useMutation();

  return (
    <StyledLink
      href={href}
      onClick={(e) => {
        e.preventDefault();
        openExternal.mutate({ url: href });
      }}
    >
      {children}
    </StyledLink>
  );
}

/** A clickable action link that fires a callback (no href) */
interface ActionLinkProps {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}

export function ActionLink({ onClick, children, title }: ActionLinkProps) {
  return (
    <StyledLink
      href="#"
      title={title}
      onClick={(e) => {
        e.preventDefault();
        onClick();
      }}
    >
      {children}
    </StyledLink>
  );
}

/** Placeholder text for empty cells */
export function Placeholder({ text = "--" }: { text?: string }) {
  return <PlaceholderText>{text}</PlaceholderText>;
}

interface ProfileSelectProps {
  profiles: string[];
  value: string | null;
  onChange: (value: string) => void;
}

export function ProfileSelect({
  profiles,
  value,
  onChange,
}: ProfileSelectProps) {
  return (
    <StyledSelect
      value={value || ""}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">-- Select Profile --</option>
      {profiles.map((p) => (
        <option key={p} value={p}>
          {p}
        </option>
      ))}
    </StyledSelect>
  );
}

interface ModelSelectProps {
  models: readonly string[];
  value: string;
  onChange: (value: string) => void;
}

export function ModelSelect({ models, value, onChange }: ModelSelectProps) {
  return (
    <StyledSelect value={value} onChange={(e) => onChange(e.target.value)}>
      {models.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </StyledSelect>
  );
}

interface CheckboxCellProps {
  checked: boolean;
  disabled?: boolean;
}

export function CheckboxCell({ checked, disabled }: CheckboxCellProps) {
  return (
    <StyledCheckbox
      type="checkbox"
      checked={checked}
      disabled={disabled}
      readOnly
    />
  );
}

/** Error indicator dot for grid rows */
const ErrorDot = styled.span`
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: ${({ theme }) => theme.colors.red};
  font-size: 11px;
  cursor: help;
`;

const ErrorDotCircle = styled.span`
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ theme }) => theme.colors.red};
  display: inline-block;
  flex-shrink: 0;
`;

interface ErrorIndicatorProps {
  errorMessage: string | null | undefined;
}

export function ErrorIndicator({ errorMessage }: ErrorIndicatorProps) {
  if (!errorMessage) return null;
  return (
    <ErrorDot title={errorMessage}>
      <ErrorDotCircle />
      Error
    </ErrorDot>
  );
}

// ─── Status Indicator Dot ────────────────────────────────

const IndicatorDot = styled.span<{ $color: string }>`
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: ${({ $color }) => $color};
  flex-shrink: 0;
`;

export type IndicatorStatus = "error" | "ready" | "in-progress";

interface StatusIndicatorProps {
  /** Error message — if set, shows red dot with tooltip */
  errorMessage?: string | null;
  /** Whether the row is disabled (in-progress / not ready) */
  disabled?: boolean;
}

/**
 * Status indicator dot for grid rows.
 *
 * - Red: error state (with tooltip showing the error message)
 * - Green: ready for user action (enabled)
 * - Yellow: in progress / waiting (disabled)
 */
export function StatusIndicator({
  errorMessage,
  disabled,
}: StatusIndicatorProps) {
  if (errorMessage) {
    return (
      <IndicatorDot
        $color="#f38ba8"
        title={errorMessage}
        style={{ cursor: "help" }}
      />
    );
  }
  if (disabled) {
    return <IndicatorDot $color="#f9e2af" title="In progress" />;
  }
  return <IndicatorDot $color="#a6e3a1" title="Ready" />;
}

// ─── Loading Spinner ─────────────────────────────────────

const SpinnerKeyframes = styled.div`
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

const SpinnerWrapper = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.spacing.lg};
`;

const SpinnerCircle = styled.div<{ $size?: number }>`
  width: ${({ $size }) => $size ?? 24}px;
  height: ${({ $size }) => $size ?? 24}px;
  border: 2px solid ${({ theme }) => theme.colors.surface1};
  border-top-color: ${({ theme }) => theme.colors.mauve};
  border-radius: 50%;
  animation: spin 0.6s linear infinite;

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
`;

const SpinnerLabel = styled.span`
  margin-left: ${({ theme }) => theme.spacing.sm};
  color: ${({ theme }) => theme.colors.overlay1};
  font-size: 13px;
`;

interface SpinnerProps {
  size?: number;
  label?: string;
}

export function Spinner({ size, label }: SpinnerProps) {
  return (
    <SpinnerWrapper>
      <SpinnerCircle $size={size} />
      {label && <SpinnerLabel>{label}</SpinnerLabel>}
    </SpinnerWrapper>
  );
}

// ─── Error Boundary ──────────────────────────────────────

const ErrorBoundaryWrapper = styled.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: ${({ theme }) => theme.spacing.xl};
  gap: ${({ theme }) => theme.spacing.md};
`;

const ErrorTitle = styled.h2`
  color: ${({ theme }) => theme.colors.red};
  font-size: 18px;
  font-weight: 600;
`;

const ErrorMessage = styled.pre`
  color: ${({ theme }) => theme.colors.subtext0};
  font-size: 12px;
  max-width: 600px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  background: ${({ theme }) => theme.colors.surface0};
  padding: ${({ theme }) => theme.spacing.md};
  border-radius: ${({ theme }) => theme.radii.md};
  border: 1px solid ${({ theme }) => theme.colors.surface1};
`;

const RetryButton = styled.button`
  background: ${({ theme }) => theme.colors.surface1};
  color: ${({ theme }) => theme.colors.text};
  border: 1px solid ${({ theme }) => theme.colors.surface2};
  border-radius: ${({ theme }) => theme.radii.sm};
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;

  &:hover {
    background: ${({ theme }) => theme.colors.surface2};
  }
`;

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Caught error:", error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <ErrorBoundaryWrapper>
          <ErrorTitle>Something went wrong</ErrorTitle>
          <ErrorMessage>
            {this.state.error?.message ?? "An unexpected error occurred"}
            {this.state.error?.stack && `\n\n${this.state.error.stack}`}
          </ErrorMessage>
          <RetryButton onClick={this.handleRetry}>Try Again</RetryButton>
        </ErrorBoundaryWrapper>
      );
    }

    return this.props.children;
  }
}

// ─── Relative Time Formatting ────────────────────────────

export function formatRelativeTime(
  date: Date | string | null | undefined,
): string {
  if (!date) return "--";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "--";
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 0) return "just now";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Activity Indicator (bouncing squares) ───────────────

const SQUARE_COUNT = 8;
const ANIMATION_DURATION = 1.6; // seconds for a full cycle

const ActivityWrapper = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 14px;
`;

const ActivitySquare = styled.span<{ $index: number; $color?: string }>`
  display: inline-block;
  width: 4px;
  height: 4px;
  border-radius: 1px;
  background: ${({ $color, theme }) => $color ?? theme.colors.blue};
  animation: bounce ${ANIMATION_DURATION}s ease-in-out infinite;
  animation-delay: ${({ $index }) => {
    // Each square gets a staggered delay creating the wave effect
    const delay = ($index / SQUARE_COUNT) * (ANIMATION_DURATION / 2);
    return `${delay}s`;
  }};

  @keyframes bounce {
    0%,
    100% {
      transform: scaleY(1);
      opacity: 0.4;
    }
    25% {
      transform: scaleY(2.2);
      opacity: 1;
    }
    50% {
      transform: scaleY(1);
      opacity: 0.4;
    }
  }
`;

interface ActivityIndicatorProps {
  /** Tooltip text shown on hover */
  tooltip?: string;
  /** Accent color for the squares (defaults to theme blue) */
  color?: string;
}

/**
 * Animated activity indicator with bouncing squares.
 *
 * Displays a wave of small squares that pulse in sequence,
 * creating a flowing left-to-right animation effect.
 * Context is provided via tooltip on hover.
 */
export function ActivityIndicator({ tooltip, color }: ActivityIndicatorProps) {
  return (
    <ActivityWrapper title={tooltip}>
      {Array.from({ length: SQUARE_COUNT }, (_, i) => (
        <ActivitySquare key={i} $index={i} $color={color} />
      ))}
    </ActivityWrapper>
  );
}
