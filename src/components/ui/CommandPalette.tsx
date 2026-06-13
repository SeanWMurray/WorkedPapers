import { useState, useRef, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";

interface Command {
  label: string;
  description?: string;
  shortcut?: string;
  action: () => void;
}

interface Props {
  onClose: () => void;
}

export default function CommandPalette({ onClose }: Props) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = [
    { label: "Trial Balance", description: "View & manage TB accounts", action: () => navigate("/tb") },
    { label: "Journal Entries", description: "Post AJEs, RJEs, TJEs", action: () => navigate("/aje") },
    { label: "Leadsheets", description: "Open a leadsheet", action: () => navigate("/leadsheet") },
    { label: "Mapping", description: "Manage map numbers & groupings", action: () => navigate("/mapping") },
    { label: "Reports", description: "Generate financial statements", action: () => navigate("/reports") },
    { label: "Audit Trail", description: "View immutable action log", action: () => navigate("/audit") },
    { label: "Settings", description: "User & app preferences", action: () => navigate("/settings") },
  ];

  const filtered = query.trim()
    ? commands.filter(
        (c) =>
          c.label.toLowerCase().includes(query.toLowerCase()) ||
          c.description?.toLowerCase().includes(query.toLowerCase())
      )
    : commands;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    setFocused(0);
  }, [query]);

  const execute = useCallback(
    (cmd: Command) => {
      cmd.action();
      onClose();
    },
    [onClose]
  );

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocused((f) => Math.min(f + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocused((f) => Math.max(f - 1, 0));
    } else if (e.key === "Enter" && filtered[focused]) {
      execute(filtered[focused]);
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="cmd-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmd-palette__input"
          placeholder="Go to..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="cmd-palette__results">
          {filtered.map((cmd, i) => (
            <div
              key={cmd.label}
              className={`cmd-palette__item${i === focused ? " focused" : ""}`}
              onClick={() => execute(cmd)}
              onMouseEnter={() => setFocused(i)}
            >
              <span>{cmd.label}</span>
              {cmd.description && (
                <span style={{ color: "inherit", opacity: 0.55, fontSize: 11 }}>
                  — {cmd.description}
                </span>
              )}
              {cmd.shortcut && (
                <span className="cmd-palette__shortcut">{cmd.shortcut}</span>
              )}
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="cmd-palette__item text-muted">No results</div>
          )}
        </div>
      </div>
    </div>
  );
}
