import type { WorkSettings } from "./api";

// The server's default workflow, for the module's tests.
const status = (key: string, en: string, de: string, category: WorkSettings["workflow"]["statuses"][number]["category"], order: number) => ({
  key,
  label: { en, de },
  category,
  order,
});

export const defaultSettings: WorkSettings = {
  workflow: {
    statuses: [
      status("backlog", "Backlog", "Backlog", "backlog", 0),
      status("todo", "To do", "Zu erledigen", "todo", 10),
      status("in_progress", "In progress", "In Arbeit", "in_progress", 20),
      status("blocked", "Blocked", "Blockiert", "blocked", 30),
      status("in_review", "In review", "In Prüfung", "in_review", 40),
      status("done", "Done", "Erledigt", "done", 50),
      status("canceled", "Canceled", "Abgebrochen", "canceled", 60),
    ],
  },
  categories: [],
  teams: [],
  wipLimits: {},
  notifications: { dueSoonDays: 2 },
};
