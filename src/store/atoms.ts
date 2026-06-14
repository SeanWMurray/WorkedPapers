import { atom } from "jotai";
import type { AppSettings, EngagementMeta, TbAccount, Aje, MapNumber, Grouping } from "@/types";

// ─── Engagement ───────────────────────────────────────────────────────────────

export const engagementAtom = atom<EngagementMeta | null>(null);

// ─── Settings ─────────────────────────────────────────────────────────────────

export const settingsAtom = atom<AppSettings>({
  user_name: "Test User",
  user_initials: "TU",
  default_currency: "USD",
  theme: "light",
  recent_files: [],
});

// ─── Trial Balance ────────────────────────────────────────────────────────────

export const tbAccountsAtom = atom<TbAccount[]>([]);

// ─── AJEs ─────────────────────────────────────────────────────────────────────

export const ajesAtom = atom<Aje[]>([]);

// ─── Mapping ──────────────────────────────────────────────────────────────────

export const mapNumbersAtom = atom<MapNumber[]>([]);
export const groupingsAtom = atom<Grouping[]>([]);

// ─── UI State ─────────────────────────────────────────────────────────────────

export const commandPaletteOpenAtom = atom<boolean>(false);

export const activeLeadsheetAtom = atom<{
  type: "map" | "group";
  key: string | number;
} | null>(null);

export const activeDocTemplateAtom = atom<number | null>(null);
