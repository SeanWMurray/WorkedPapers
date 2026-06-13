import { NavLink } from "react-router-dom";

const NAV = [
  { to: "/tb", label: "Trial Balance" },
  { to: "/aje", label: "Journal Entries" },
  { to: "/leadsheet", label: "Leadsheets" },
  { to: "/mapping", label: "Mapping" },
  { to: "/reports", label: "Reports" },
  { to: "/files", label: "Files" },
];

const SETTINGS_NAV = [
  { to: "/audit", label: "Audit Trail" },
  { to: "/settings", label: "Settings" },
];

export default function AppSidebar() {
  return (
    <nav className="app-sidebar no-select">
      <div className="sidebar-section">
        <div className="sidebar-section__label">Engagement</div>
        {NAV.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar-nav-item${isActive ? " active" : ""}`
            }
          >
            {label}
          </NavLink>
        ))}
      </div>

      <div className="sidebar-section" style={{ marginTop: "auto" }}>
        <div className="sidebar-section__label">System</div>
        {SETTINGS_NAV.map(({ to, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `sidebar-nav-item${isActive ? " active" : ""}`
            }
          >
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
