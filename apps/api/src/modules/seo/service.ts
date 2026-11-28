import { scoped, type DbTx } from "../../../../../packages/db/src/index.ts";
import type { Scope } from "../../../../../packages/schemas/src/index.ts";
import type { z } from "zod";
import { actorScope } from "../../platform/tenancy/member-scope.ts";
import { audit, DomainError } from "../../shared.ts";
import {
  bindPropertyInput,
  createWebsiteInput,
  searchPerformanceQuery,
} from "./contract.ts";
import { requireSeoAccess } from "./gate.ts";
import { SEO_MANAGE, SEO_READ } from "./permissions.ts";
import { requireSeoProvider } from "./providers.ts";

const project = ({ workspaceId, projectId }: Scope) => ({
  workspaceId,
  projectId,
});
const activeWebsites = (scope: Scope) => ({
  ...project(scope),
  archivedAt: null,
});
const websiteFields = {
  id: true,
  name: true,
  url: true,
  properties: {
    orderBy: { provider: "asc" as const },
    select: { provider: true, connectionId: true, propertyId: true },
  },
} as const;

async function requireWebsite(tx: DbTx, scope: Scope, websiteId: string) {
  const site = await tx.seoWebsite.findFirst({
    where: { ...activeWebsites(scope), id: websiteId },
    select: websiteFields,
  });
  if (!site) throw new DomainError("SEO_WEBSITE_NOT_FOUND", 404);
  return site;
}

export async function listSeoWebsites(tx: DbTx, scope: Scope) {
  await requireSeoAccess(tx, scope, SEO_READ);
  return tx.seoWebsite.findMany({
    where: activeWebsites(scope),
    select: websiteFields,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
}

export async function createSeoWebsite(tx: DbTx, scope: Scope, input: unknown) {
  const { seoWebsitesMax } = await requireSeoAccess(tx, scope, SEO_MANAGE);
  const data = createWebsiteInput.parse(input);
  const where = activeWebsites(scope);
  if (
    await tx.seoWebsite.findFirst({
      where: { ...where, url: data.url },
      select: { id: true },
    })
  )
    throw new DomainError("SEO_WEBSITE_EXISTS", 409);
  // Orbit's project transaction serializes the quota check and insert.
  if (
    seoWebsitesMax != null &&
    (await tx.seoWebsite.count({ where })) >= seoWebsitesMax
  )
    throw new DomainError("SEO_WEBSITE_LIMIT", 409);
  const site = await tx.seoWebsite.create({
    data: { ...project(scope), ...data },
    select: websiteFields,
  });
  await audit(tx, scope, "seo.website_created", site.id, {});
  return site;
}

export async function archiveSeoWebsite(
  tx: DbTx,
  scope: Scope,
  websiteId: string,
) {
  await requireSeoAccess(tx, scope, SEO_MANAGE);
  const { count } = await tx.seoWebsite.updateMany({
    where: { ...activeWebsites(scope), id: websiteId },
    data: { archivedAt: new Date() },
  });
  if (!count) throw new DomainError("SEO_WEBSITE_NOT_FOUND", 404);
  await audit(tx, scope, "seo.website_archived", websiteId, {});
}

async function requireCurrentActor(scope: Scope) {
  const current = await actorScope(
    scope.workspaceId,
    scope.projectId,
    scope.userId,
  );
  if (!current) throw new DomainError("NOT_FOUND", 404);
  return current;
}

export async function listSeoProperties(
  scope: Scope,
  providerId: string,
  connectionId: string,
) {
  const provider = requireSeoProvider(providerId);
  const read = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSeoAccess(tx, scope, SEO_MANAGE);
    return provider.preparePropertyListing(tx, scope, connectionId);
  });
  const properties = await read();
  const current = await requireCurrentActor(scope);
  await scoped(current.workspaceId, current.projectId, async (tx) => {
    await requireSeoAccess(tx, current, SEO_MANAGE);
    await provider.preparePropertyListing(tx, current, connectionId);
  });
  return properties.map(({ externalId, label }) => ({ id: externalId, label }));
}

export async function bindSeoProperty(
  scope: Scope,
  websiteId: string,
  providerId: string,
  input: unknown,
) {
  const provider = requireSeoProvider(providerId);
  const { connectionId, propertyId } = bindPropertyInput.parse(input);
  const read = await scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSeoAccess(tx, scope, SEO_MANAGE);
    await requireWebsite(tx, scope, websiteId);
    return provider.preparePropertyListing(tx, scope, connectionId);
  });
  if (!(await read()).some((property) => property.externalId === propertyId))
    throw new DomainError("SEO_PROPERTY_NOT_AVAILABLE", 404);

  const current = await requireCurrentActor(scope);
  return scoped(scope.workspaceId, scope.projectId, async (tx) => {
    await requireSeoAccess(tx, current, SEO_MANAGE);
    const website = await requireWebsite(tx, current, websiteId);
    // Check that the specific provider connection is still granted after the outbound read.
    await provider.preparePropertyListing(tx, current, connectionId);
    const existing = website.properties.find(
      (binding) => binding.provider === providerId,
    );
    if (
      existing?.connectionId === connectionId &&
      existing.propertyId === propertyId
    )
      return website;
    const key = { ...project(current), websiteId, provider: providerId };
    await tx.seoWebsiteProperty.upsert({
      where: { workspaceId_projectId_websiteId_provider: key },
      create: { ...key, connectionId, propertyId },
      update: { connectionId, propertyId },
    });
    await audit(tx, current, "seo.property_bound", websiteId, {
      provider: providerId,
    });
    return requireWebsite(tx, current, websiteId);
  });
}

export async function unbindSeoProperty(
  tx: DbTx,
  scope: Scope,
  websiteId: string,
  providerId: string,
) {
  await requireSeoAccess(tx, scope, SEO_MANAGE);
  requireSeoProvider(providerId);
  await requireWebsite(tx, scope, websiteId);
  const { count } = await tx.seoWebsiteProperty.deleteMany({
    where: { ...project(scope), websiteId, provider: providerId },
  });
  if (count)
    await audit(tx, scope, "seo.property_unbound", websiteId, {
      provider: providerId,
    });
}

export async function searchPerformance(
  scope: Scope,
  websiteId: string,
  input: z.input<typeof searchPerformanceQuery>,
) {
  const {
    provider: providerId,
    startDate,
    endDate,
    dimension,
    limit,
  } = searchPerformanceQuery.parse(input);
  const provider = requireSeoProvider(providerId);
  async function prepare(tx: DbTx, actor: Scope) {
    await requireSeoAccess(tx, actor, SEO_READ);
    const website = await requireWebsite(tx, actor, websiteId);
    const binding = website.properties.find(
      (property) => property.provider === providerId,
    );
    if (!binding) throw new DomainError("SEO_PROPERTY_NOT_LINKED", 404);
    const read = await provider.preparePerformance(tx, actor, {
      connectionId: binding.connectionId,
      externalId: binding.propertyId,
      startDate,
      endDate,
      dimension,
      limit,
    });
    return { binding, read };
  }

  const { binding, read } = await scoped(
    scope.workspaceId,
    scope.projectId,
    (tx) => prepare(tx, scope),
  );
  const { rows } = await read();

  // A request may have been in flight when a role, module or grant was
  // revoked. Release provider data only while the original binding holds.
  const current = await requireCurrentActor(scope);
  await scoped(current.workspaceId, current.projectId, async (tx) => {
    const latest = await prepare(tx, current);
    if (
      latest.binding.connectionId !== binding.connectionId ||
      latest.binding.propertyId !== binding.propertyId
    )
      throw new DomainError("SEO_PROPERTY_CHANGED", 409);
  });
  return {
    provider: providerId,
    websiteId,
    startDate,
    endDate,
    dimension,
    rows,
  };
}
