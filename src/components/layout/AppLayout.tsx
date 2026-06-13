import { Outlet } from "react-router-dom";
import { useAtom } from "jotai";
import { commandPaletteOpenAtom } from "@/store/atoms";
import AppHeader from "./AppHeader";
import AppSidebar from "./AppSidebar";
import CommandPalette from "@/components/ui/CommandPalette";
import { useEffect } from "react";

export default function AppLayout() {
  const [cmdOpen, setCmdOpen] = useAtom(commandPaletteOpenAtom);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setCmdOpen((v) => !v);
      }
      if (e.key === "Escape" && cmdOpen) {
        setCmdOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cmdOpen, setCmdOpen]);

  return (
    <div className="app-shell">
      <AppHeader />
      <AppSidebar />
      <main className="app-main">
        <Outlet />
      </main>
      {cmdOpen && <CommandPalette onClose={() => setCmdOpen(false)} />}
    </div>
  );
}
