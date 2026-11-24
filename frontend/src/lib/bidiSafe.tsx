/**
 * Bidi-safe text rendering component (Issue #792)
 * Automatically isolates text to prevent bidi-override spoofing attacks
 */

import React from "react";
import { stripBidiOverrides, isolateBidi, hasBidiOverrides } from "./bidi";

interface BidiSafeProps {
  children: string;
  /** If true, strips bidi overrides; if false, throws on detection */
  stripOverrides?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Renders text with bidi isolation to prevent spoofing attacks
 * Use for all user-generated content, addresses, and mixed-direction text
 */
export const BidiSafe: React.FC<BidiSafeProps> = ({
  children,
  stripOverrides = true,
  className = "",
}) => {
  if (hasBidiOverrides(children)) {
    if (!stripOverrides) {
      console.error("Bidi override characters detected in text:", children);
    }
    const safe = stripOverrides ? stripBidiOverrides(children) : children;
    return <span className={className} dir="auto">{isolateBidi(safe)}</span>;
  }

  return <span className={className} dir="auto">{isolateBidi(children)}</span>;
};

/**
 * Renders Stellar addresses with bidi isolation and monospace font
 */
export const SafeAddress: React.FC<{ address: string; className?: string }> = ({
  address,
  className = "",
}) => {
  return (
    <BidiSafe className={`font-mono ${className}`}>
      {address}
    </BidiSafe>
  );
};
