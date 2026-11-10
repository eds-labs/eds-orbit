"use client";
// API paths and the mutation hook of the agent pages (ADR 0021, WP1.8).
import { useRef, useState } from "react";
import { ApiError } from "@/lib/api";

const project = (projectId: string) =>
  `/projects/${encodeURIComponent(projectId)}`;

export const agentPaths = {
  list: (p: string) => `${project(p)}/agents`,
  catalog: (p: string) => `${project(p)}/agents/catalog`,
  templates: (p: string) => `${project(p)}/agents/templates`,
  agent: (p: string, id: string) =>
    `${project(p)}/agents/${encodeURIComponent(id)}`,
  action: (p: string, id: string, action: string) =>
    `${project(p)}/agents/${encodeURIComponent(id)}/${action}`,
  versions: (p: string, id: string) =>
    `${project(p)}/agents/${encodeURIComponent(id)}/versions`,
  runs: (p: string, id: string) =>
    `${project(p)}/agents/${encodeURIComponent(id)}/runs`,
  workOrders: (
    p: string,
    query: {
      agentId?: string;
      status?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
      if (value !== undefined && value !== "") params.set(key, String(value));
    const search = params.toString();
    return `${project(p)}/agent-work-orders${search ? `?${search}` : ""}`;
  },
  workOrder: (p: string, id: string) =>
    `${project(p)}/agent-work-orders/${encodeURIComponent(id)}`,
  summary: () => "/agents/summary",
};

/** The error code of a failed request ("REQUEST_FAILED" for other errors). */
export const errorCode = (error: unknown) =>
  error instanceof ApiError ? error.code : "REQUEST_FAILED";

/**
 * A mutation with a pending lock that keeps the server's error code, so
 * the page can show a readable text for it (agentErrorText).
 */
export function useAgentAction() {
  const [pending, setPending] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const lock = useRef(false);
  async function run<T>(task: () => Promise<T>): Promise<T | undefined> {
    if (lock.current) return undefined;
    lock.current = true;
    setPending(true);
    setCode(null);
    try {
      return await task();
    } catch (e) {
      setCode(errorCode(e));
      return undefined;
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return { run, pending, code, clear: () => setCode(null) };
}

export const requestId = () => crypto.randomUUID();
