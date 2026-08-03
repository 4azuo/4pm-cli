/**
 * Spinner — a tiny animated braille spinner (no extra dependency) used in the
 * processing status line while a tool (claude/codex/…) runs (ADR-0057).
 */
import React, { useEffect, useState } from "react";
import { Text } from "ink";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** An animated single-char spinner. */
export function Spinner(): React.ReactElement {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    // 120ms (was 90ms) — one fewer forced re-render per second while a command runs (ADR-0177).
    const timer = setInterval(() => setIndex((i) => (i + 1) % FRAMES.length), 120);
    return () => clearInterval(timer);
  }, []);
  return <Text color="yellow">{FRAMES[index]}</Text>;
}
