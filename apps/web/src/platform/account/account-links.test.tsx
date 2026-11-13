import { describe, expect, it, vi } from "vitest";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/manage/me/profile",
}));
vi.mock("@/lib/api", async (original) => ({
  ...(await original<typeof import("@/lib/api")>()),
  useResource: (path: string | null) => ({
    data: path === "/account" ? profile : path ? { items: [] } : null,
    error: null,
    loading: false,
    refresh: () => {},
  }),
}));
import { renderToStaticMarkup } from "react-dom/server";
import { labels } from "@/lib/i18n";
import {
  AssistantContext,
  type AssistantContextValue,
} from "@/platform/assistant/assistant-context";
import {
  StandaloneContext,
  type StandaloneContextValue,
} from "@/platform/shell/standalone-context";
import { AccountView } from "./account-view";
import { PersonalContextView } from "./personal-context";

const profile = {
  id: "u1",
  name: "Synthetic Member",
  email: "member@example.invalid",
  emailVerified: true,
  locale: "en",
  systemAdmin: false,
  emailChange: false,
};
const standalone = {
  locale: "en",
  t: (key: keyof typeof labels.en) => labels.en[key],
  identity: null,
} as unknown as StandaloneContextValue;
// Disabled: the context page then shows only its head and a notice.
const assistant = {
  available: true,
  enabled: false,
  status: null,
} as unknown as AssistantContextValue;

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <StandaloneContext.Provider value={standalone}>
      <AssistantContext.Provider value={assistant}>{node}</AssistantContext.Provider>
    </StandaloneContext.Provider>,
  );

describe("account links address the center", () => {
  it("links the account page's assistant card to the account scope's assistant section", () => {
    const html = render(<AccountView />);
    expect(html).toContain('href="/manage/me/assistant"');
    expect(html).not.toMatch(/href="\/account/);
  });

  it("links My context back to the account scope, not to one section", () => {
    const html = render(<PersonalContextView />);
    expect(html).toContain('class="back-link" href="/manage/me"');
    expect(html).not.toMatch(/href="\/account/);
  });
});
