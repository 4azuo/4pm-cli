/**
 * CommandInput — the command write field of the TUI (ADR-0057): the operator types a
 * prompt for the AI CLI, or a `/…` slash command. Slash commands autocomplete: typing
 * `/` shows matching commands (Tab to complete, ↑/↓ to pick while the menu is open).
 * Up/Down otherwise recall the persistent input history. Minimal controlled field on
 * Ink's useInput (no extra dependency). Separators / hint are laid out by App.
 */
import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { SessionStatus } from "../core/session-bus";
import { SLASH_COMMANDS } from "./slash-commands";

/** The bottom hint line — shortcuts only (connection status lives in the header). */
export function Hint(): React.ReactElement {
  return <Text dimColor>{"  /help · Tab complete · ↑↓ history · PgUp/PgDn scroll · Ctrl+C quit"}</Text>;
}

/** The command write field (2 rows: a suggestion line + the input line). */
export function CommandInput({
  status,
  history,
  onSubmit,
}: {
  status: SessionStatus;
  history: string[];
  onSubmit: (input: string) => void;
}): React.ReactElement {
  const { exit } = useApp();
  const [value, setValue] = useState("");
  // Index into `history` while browsing with Up/Down; null = editing a fresh draft.
  const [navIndex, setNavIndex] = useState<number | null>(null);
  const [sugIndex, setSugIndex] = useState(0);
  const connected = status === "connected";

  // Slash autocomplete: only while typing the command word (a leading `/`, no space yet).
  const matching =
    value.startsWith("/") && !value.includes(" ")
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(value.slice(1)))
      : [];
  const menuOpen = matching.length > 0;
  const selected = matching[Math.min(sugIndex, matching.length - 1)];

  useInput((input, key) => {
    // Ctrl+C / Ctrl+D ⇒ quit the cli.
    if (key.ctrl && (input === "c" || input === "d")) {
      exit();
      return;
    }
    // Tab ⇒ complete the highlighted suggestion (adds a trailing space, closes the menu).
    if (key.tab && selected) {
      setValue(`/${selected.name} `);
      setSugIndex(0);
      setNavIndex(null);
      return;
    }
    // Up/Down move the suggestion menu when open; otherwise browse the input history.
    if (key.upArrow) {
      if (menuOpen) {
        setSugIndex((i) => (i - 1 + matching.length) % matching.length);
        return;
      }
      if (history.length === 0) return;
      const next = navIndex === null ? history.length - 1 : Math.max(0, navIndex - 1);
      setNavIndex(next);
      setValue(history[next] ?? "");
      return;
    }
    if (key.downArrow) {
      if (menuOpen) {
        setSugIndex((i) => (i + 1) % matching.length);
        return;
      }
      if (navIndex === null) return;
      const next = navIndex + 1;
      if (next >= history.length) {
        setNavIndex(null);
        setValue("");
      } else {
        setNavIndex(next);
        setValue(history[next] ?? "");
      }
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed.length > 0) onSubmit(trimmed);
      setValue("");
      setNavIndex(null);
      setSugIndex(0);
      return;
    }
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      setNavIndex(null);
      setSugIndex(0);
      return;
    }
    // Ignore other control keys; append printable input (may be a pasted chunk).
    if (!key.ctrl && !key.meta && input) {
      setValue((v) => v + input);
      setNavIndex(null);
      setSugIndex(0);
    }
  });

  return (
    <Box flexDirection="column">
      <Box>
        {menuOpen ? (
          <Text>
            {matching.map((c, i) => (
              <Text key={c.name} color={i === sugIndex ? "cyan" : "gray"} inverse={i === sugIndex}>
                {" "}
                /{c.name}{" "}
              </Text>
            ))}
            {selected ? <Text dimColor>  — {selected.description} (Tab)</Text> : null}
          </Text>
        ) : (
          <Text> </Text>
        )}
      </Box>
      <Box>
        <Text color={connected ? "cyan" : "gray"}>{"› "}</Text>
        <Text>{value}</Text>
        <Text inverse> </Text>
      </Box>
    </Box>
  );
}
