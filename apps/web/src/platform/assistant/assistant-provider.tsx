"use client";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useResource, type Identity } from "@/lib/api";
import type { Locale } from "@/lib/i18n";
import { assistantPaths, type AssistantStatus } from "./api";
import { AssistantLinkContext, type AssistantLinks } from "./links";
import { useAssistantConversation } from "./use-assistant-conversation";
import {
  ASSISTANT_PAGE,
  AssistantContext,
  PAGE_INPUT_ID,
  PANEL_INPUT_ID,
  assistantSession,
  followFocus,
  isAssistantShortcut,
  readBubbleHidden,
  writeBubbleHidden,
  type AssistantContextValue,
} from "./assistant-context";
import { AssistantBubble } from "./assistant-bubble";
import { AssistantPanel } from "./assistant-panel";

// The personal Orbit Assistant in the shell (ADR 0022 D-10, WP3.8): one
// provider around every authenticated page holds the assistant's status,
// the personal conversation, the panel's open state and the focus project.
// The shell mounts it outside the keyed workspace <div>, so the bubble, the
// panel and a running reply survive project switches.

export function AssistantProvider({
  identity,
  locale,
  pathname,
  routeProjectId,
  workspaceId,
  links,
  aboveNav,
  children,
}: {
  identity: Identity;
  locale: Locale;
  pathname: string;
  /** The open business project, if the page is one of its pages. */
  routeProjectId?: string;
  /** The organization whose personal space is used; else the server's default. */
  workspaceId?: string;
  links: AssistantLinks;
  /** The page has the phone bottom bar: the bubble and sheet sit above it. */
  aboveNav: boolean;
  children: ReactNode;
}) {
  const de = locale === "de";
  const userId = identity.user.id;
  const status = useResource<AssistantStatus>(
    assistantPaths.status(workspaceId),
  );
  // A failed or 404 status hides the assistant: never a half-working bubble.
  const data = status.data;
  const available = Boolean(data);
  const enabled = Boolean(data?.enabled);
  const personalSpaceId = assistantSession(data);
  const [isOpen, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [unseen, setUnseen] = useState(false);
  const [bubbleHidden, setHidden] = useState(false);
  const [focus, setFocus] = useState(routeProjectId ?? "");
  const lastRoute = useRef(routeProjectId);
  const openRef = useRef(false);
  openRef.current = isOpen || pathname === ASSISTANT_PAGE;
  const bubbleRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setHidden(readBubbleHidden(userId)), [userId]);
  useEffect(() => {
    setFocus((current) =>
      followFocus(lastRoute.current, routeProjectId, current),
    );
    lastRoute.current = routeProjectId;
  }, [routeProjectId]);
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const pageRef = useRef({ pathname, routeProjectId });
  pageRef.current = { pathname, routeProjectId };
  const conversation = useAssistantConversation({
    projectId: personalSpaceId,
    storageKey: `orbit.assistant.${userId}.${personalSpaceId}`,
    readLink: pathname === ASSISTANT_PAGE,
    personal: true,
    de,
    extras: () => ({
      ...(focusRef.current ? { focusProjectId: focusRef.current } : {}),
      pageContext: {
        ...(pageRef.current.routeProjectId
          ? { projectId: pageRef.current.routeProjectId }
          : {}),
        route: pageRef.current.pathname,
      },
    }),
    onRunEnd: () => {
      if (!openRef.current) setUnseen(true);
    },
  });
  const openPanel = useCallback(
    (options?: { draft?: string }) => {
      if (options?.draft) setInput(options.draft);
      setUnseen(false);
      if (pathname === ASSISTANT_PAGE) {
        document.getElementById(PAGE_INPUT_ID)?.focus();
        return;
      }
      if (isOpen) document.getElementById(PANEL_INPUT_ID)?.focus();
      setOpen(true);
    },
    [isOpen, pathname],
  );
  const closePanel = useCallback(() => setOpen(false), []);
  const setBubbleHidden = useCallback(
    (hidden: boolean) => {
      setHidden(hidden);
      writeBubbleHidden(userId, hidden);
    },
    [userId],
  );
  // The panel closes when the page navigates to the full assistant page,
  // and on phones, where the sheet would cover the page a link opened.
  useEffect(() => {
    if (
      pathname === ASSISTANT_PAGE ||
      window.matchMedia?.("(max-width: 760px)").matches
    )
      setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!available) return;
    function handle(event: KeyboardEvent) {
      if (!isAssistantShortcut(event)) return;
      event.preventDefault();
      openPanel();
    }
    document.addEventListener("keydown", handle);
    return () => document.removeEventListener("keydown", handle);
  }, [available, openPanel]);
  const projects = useMemo(
    () =>
      identity.projects.filter(
        (p) => !data?.workspaceId || p.workspaceId === data.workspaceId,
      ),
    [identity.projects, data?.workspaceId],
  );
  const value: AssistantContextValue = {
    available,
    enabled,
    status: data,
    conversation,
    locale,
    isOpen,
    openPanel,
    closePanel,
    focusProjectId: focus,
    setFocusProjectId: setFocus,
    projects,
    input,
    setInput,
    bubbleHidden,
    setBubbleHidden,
    unseen,
  };
  const onPage = pathname === ASSISTANT_PAGE;
  return (
    <AssistantLinkContext.Provider value={links}>
      <AssistantContext.Provider value={value}>
        {children}
        {available && !onPage && !bubbleHidden && (
          <AssistantBubble ref={bubbleRef} aboveNav={aboveNav} />
        )}
        {available && !onPage && (
          <AssistantPanel aboveNav={aboveNav} returnFocus={bubbleRef} />
        )}
      </AssistantContext.Provider>
    </AssistantLinkContext.Provider>
  );
}
