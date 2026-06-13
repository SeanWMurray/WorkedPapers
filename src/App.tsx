import { useEffect } from "react";
import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import { useAtom, useSetAtom } from "jotai";
import { engagementAtom, settingsAtom } from "@/store/atoms";
import { getSettings } from "@/lib/tauri";

import AppLayout from "@/components/layout/AppLayout";
import WelcomePage from "@/pages/WelcomePage";
import TrialBalancePage from "@/pages/TrialBalancePage";
import AjePage from "@/pages/AjePage";
import LeadsheetPage from "@/pages/LeadsheetPage";
import MappingPage from "@/pages/MappingPage";
import ReportsPage from "@/pages/ReportsPage";
import FilesPage from "@/pages/FilesPage";
import AuditPage from "@/pages/AuditPage";
import SettingsPage from "@/pages/SettingsPage";

export default function App() {
  const [engagement] = useAtom(engagementAtom);
  const [settings, setSettings] = useAtom(settingsAtom);

  useEffect(() => {
    getSettings().then((s) => {
      setSettings(s);
      document.documentElement.setAttribute("data-theme", s.theme);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  return (
    <HashRouter>
      <Routes>
        {!engagement ? (
          <Route path="*" element={<WelcomePage />} />
        ) : (
          <Route element={<AppLayout />}>
            <Route index element={<Navigate to="/tb" replace />} />
            <Route path="/tb" element={<TrialBalancePage />} />
            <Route path="/aje" element={<AjePage />} />
            <Route path="/leadsheet" element={<LeadsheetPage />} />
            <Route path="/mapping" element={<MappingPage />} />
            <Route path="/reports" element={<ReportsPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/audit" element={<AuditPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/tb" replace />} />
          </Route>
        )}
      </Routes>
    </HashRouter>
  );
}
