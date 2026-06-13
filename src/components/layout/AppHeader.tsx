import { useAtom } from "jotai";
import { engagementAtom } from "@/store/atoms";
import { closeEngagement } from "@/lib/tauri";
import { formatDate } from "@/lib/format";

export default function AppHeader() {
  const [engagement, setEngagement] = useAtom(engagementAtom);

  const handleClose = async () => {
    await closeEngagement();
    setEngagement(null);
  };

  return (
    <header className="app-header">
      <span className="app-header__logo">Worked Papers</span>

      {engagement && (
        <span className="app-header__engagement">
          {engagement.entity_name} — YE {formatDate(engagement.year_end)}
          {engagement.is_locked && (
            <span className="badge badge-locked" style={{ marginLeft: 8 }}>
              LOCKED
            </span>
          )}
        </span>
      )}

      <div className="app-header__actions">
        <span style={{ fontSize: 11, color: "var(--color-text-muted)" }}>
          Ctrl+K
        </span>
        {engagement && (
          <button className="btn btn-sm" onClick={handleClose}>
            Close
          </button>
        )}
      </div>
    </header>
  );
}
