/**
 * A minimal arrow-key list picker (ADR-0063): render a short Ink app, let the operator
 * move with ↑/↓ and pick with Enter (Esc/Ctrl+C cancels). Used by `4pm start` / `4pm
 * unlink` to choose a profile when several exist, instead of requiring `--profile`.
 * Requires a TTY (raw mode); callers fall back to `--profile` when headless.
 */
import React, { useState } from "react";
import { Box, render, Text, useApp, useInput } from "ink";

/** One selectable item. */
export interface PickItem {
  label: string;
  value: string;
}

/** The interactive list. Calls onDone with the chosen value (or null on cancel). */
function Picker({
  items,
  title,
  onDone,
}: {
  items: PickItem[];
  title: string;
  onDone: (value: string | null) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [index, setIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) setIndex((i) => (i - 1 + items.length) % items.length);
    else if (key.downArrow) setIndex((i) => (i + 1) % items.length);
    else if (key.return) {
      onDone(items[index]?.value ?? null);
      exit();
    } else if (key.escape || (key.ctrl && input === "c")) {
      onDone(null);
      exit();
    }
  });

  return (
    <Box flexDirection="column" paddingY={1}>
      <Text bold>{title}</Text>
      {items.map((item, i) => (
        <Text key={item.value} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {item.label}
        </Text>
      ))}
      <Text dimColor>↑↓ move · Enter select · Esc cancel</Text>
    </Box>
  );
}

/**
 * Render the picker and resolve with the chosen value (null on cancel). Unmounts before
 * resolving so a subsequent Ink app (the start TUI) can take over cleanly.
 */
export function selectFromList(items: PickItem[], title: string): Promise<string | null> {
  return new Promise((resolve) => {
    let chosen: string | null = null;
    const app = render(<Picker items={items} title={title} onDone={(v) => (chosen = v)} />);
    void app.waitUntilExit().then(() => resolve(chosen));
  });
}
