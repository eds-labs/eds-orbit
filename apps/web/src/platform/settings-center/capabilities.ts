"use client";
import { useResource, type ApiError } from "@/lib/api";
import { defaultScope, manageHref } from "./routes";
import type {
  Capability,
  ManageScope,
  ManageTarget,
  ManagementCapabilities,
} from "./types";

/**
 * What the member may do in the settings center. Requested only while
 * `enabled`: the API answers 404 while the flag is off, and pages other than
 * /manage never need it.
 */
export function useManagementCapabilities(enabled: boolean): {
  data: ManagementCapabilities | null;
  loading: boolean;
  error: ApiError | null;
  refresh(): void;
} {
  const { data, loading, error, refresh } = useResource<ManagementCapabilities>(
    enabled ? "/management/capabilities" : null,
  );
  return { data, loading, error, refresh };
}

/**
 * The page part of the document title on /manage: known only once /me has
 * reported the stage, and absent while the flag is off (the address is then
 * not found, as before the settings center).
 */
export function manageTitleKey(
  isManagePlace: boolean,
  stage: "off" | "preview" | "on" | undefined,
): "manageTitle" | null {
  return isManagePlace && (stage === "preview" || stage === "on")
    ? "manageTitle"
    : null;
}

export type CenterState =
  | { kind: "off" }
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "redirect"; href: string }
  | { kind: "notFound" }
  | {
      kind: "scope";
      scope: ManageScope;
      capabilities: readonly Capability[];
      /** Organization or project name; "" for system and account. */
      name: string;
    };

/**
 * What the shell shows at a /manage address. Pure, so the shell only maps
 * the result to a view. A scope the capabilities do not list is not found,
 * whether it does not exist or the member's role does not include it.
 */
export function centerState(input: {
  stage: "off" | "preview" | "on" | undefined;
  target: ManageTarget;
  caps: ManagementCapabilities | null;
  loading: boolean;
  error: { message: string } | null;
  lastProjectId: string | null;
}): CenterState {
  const { stage, target, caps, error } = input;
  if (!stage || stage === "off") return { kind: "off" };
  if (error) return { kind: "error", message: error.message };
  if (!caps) return { kind: "loading" };
  const scope = target.scope;
  if (!scope) {
    const next = defaultScope(caps, input.lastProjectId);
    return next
      ? { kind: "redirect", href: manageHref(next) }
      : { kind: "notFound" };
  }
  const found = (
    capabilities: readonly Capability[],
    name = "",
  ): CenterState =>
    capabilities.length
      ? { kind: "scope", scope, capabilities, name }
      : { kind: "notFound" };
  switch (scope.kind) {
    case "system":
      return found(caps.system);
    case "account":
      return found(caps.account);
    case "organization": {
      const organization = caps.organizations.find(
        (o) => o.id === scope.organizationId,
      );
      return organization
        ? found(organization.capabilities, organization.name)
        : { kind: "notFound" };
    }
    case "project": {
      const project = caps.projects.find((p) => p.id === scope.projectId);
      return project
        ? found(project.capabilities, project.name)
        : { kind: "notFound" };
    }
  }
}
