"use client";

import { useEffect, useId, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Globe } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  FieldLabel,
  Input,
  Loading,
  Modal,
} from "@/components/ui/primitives";
import { useWorkspace } from "@/components/workspace-context";
import {
  MutationCanceled,
  post,
  put,
  remove,
  useMutation,
  useResource,
} from "@/lib/api";
import { useShell } from "@/platform/shell/shell-context";
import { AppLink } from "@/platform/ui/app-link";
import { PageHead } from "@/platform/ui/collection";
import {
  connectionPath,
  propertyPath,
  providerPath,
  seoPath,
  websitePath,
  type ProviderProperty,
  type SeoOverview,
  type SeoProvider,
  type SeoWebsite,
} from "./api";
import { seoError, seoText } from "./labels";
import { SeoRequestError } from "./overview";
import styles from "./seo.module.css";

type ConfirmAction = {
  title: string;
  description: string;
  label: string;
  path: string;
};

function AddWebsite({
  pending,
  error,
  onClose,
  onAdd,
}: {
  pending: boolean;
  error: string | null;
  onClose(): void;
  onAdd(website: { name: string; url: string }): void;
}) {
  const { locale } = useWorkspace();
  const t = seoText(locale);
  const id = useId();
  return (
    <Modal title={t.addWebsite} onClose={onClose}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          onAdd({
            name: String(data.get("name")).trim(),
            url: String(data.get("url")).trim(),
          });
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-name`}>{t.siteName}</FieldLabel>
          <Input id={`${id}-name`} name="name" required maxLength={120} />
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-url`}>{t.siteUrl}</FieldLabel>
          <Input
            id={`${id}-url`}
            name="url"
            type="url"
            inputMode="url"
            required
            pattern="[Hh][Tt][Tt][Pp][Ss]?://.+"
            maxLength={2048}
            aria-describedby={`${id}-hint`}
          />
          <p id={`${id}-hint`} className="field-hint">
            {t.siteUrlHint}
          </p>
        </Field>
        {error && <Alert kind="error">{error}</Alert>}
        <div className={styles.actions}>
          <Button type="submit" disabled={pending}>
            {t.addWebsite}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function LinkProperty({
  website,
  providers,
  pending,
  error,
  onClose,
  onLink,
}: {
  website: SeoWebsite;
  providers: SeoProvider[];
  pending: boolean;
  error: string | null;
  onClose(): void;
  onLink(
    providerId: string,
    binding: { connectionId: string; propertyId: string },
  ): void;
}) {
  const { project, locale } = useWorkspace();
  const id = useId();
  const t = seoText(locale);
  const [providerId, setProviderId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [propertyId, setPropertyId] = useState("");
  const provider =
    providers.find((item) => item.id === providerId) ?? providers[0];
  const active =
    provider?.connections.filter((connection) => !connection.unavailable) ?? [];
  const connection =
    active.find((item) => item.id === connectionId) ?? active[0];
  const path =
    provider && connection
      ? seoPath(
          project.id,
          `${connectionPath(provider.id, connection.id)}/properties`,
        )
      : null;
  const properties = useResource<{ properties: ProviderProperty[] }>(path);
  const options =
    properties.path === path && !properties.loading
      ? (properties.data?.properties ?? [])
      : [];
  const property = options.find((item) => item.id === propertyId);
  const previous = website.properties.find(
    (item) => item.provider === provider?.id,
  );

  return (
    <Modal title={t.link} description={website.name} onClose={onClose}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (provider && connection && property) {
            onLink(provider.id, {
              connectionId: connection.id,
              propertyId: property.id,
            });
          }
        }}
      >
        <Field>
          <FieldLabel htmlFor={`${id}-provider`}>{t.selectProvider}</FieldLabel>
          <select
            className="input"
            id={`${id}-provider`}
            value={provider?.id ?? ""}
            onChange={(event) => {
              setProviderId(event.target.value);
              setConnectionId("");
              setPropertyId("");
            }}
          >
            {providers.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Field>
          <FieldLabel htmlFor={`${id}-connection`}>
            {t.selectConnection}
          </FieldLabel>
          <select
            className="input"
            id={`${id}-connection`}
            value={connection?.id ?? ""}
            onChange={(event) => {
              setConnectionId(event.target.value);
              setPropertyId("");
            }}
          >
            {active.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        {properties.loading && <Loading label={t.checkingProperties} />}
        {properties.errorPath === path && properties.error && (
          <SeoRequestError
            error={properties.error}
            retry={properties.refresh}
          />
        )}
        {properties.path === path &&
          properties.data &&
          !properties.loading &&
          !options.length && <p>{t.noProperties}</p>}
        {options.length > 0 && (
          <Field>
            <FieldLabel htmlFor={`${id}-property`}>
              {t.selectProperty}
            </FieldLabel>
            <select
              className="input"
              id={`${id}-property`}
              required
              value={property?.id ?? ""}
              onChange={(event) => setPropertyId(event.target.value)}
            >
              <option value="">{t.choose}</option>
              {options.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
        )}
        {previous && (
          <p className="field-hint">{t.replaceLink(previous.propertyId)}</p>
        )}
        {error && <Alert kind="error">{error}</Alert>}
        <div className={styles.actions}>
          <Button type="submit" disabled={pending || !property}>
            {t.link}
          </Button>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            {t.cancel}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function SeoManagement() {
  const { project, locale } = useWorkspace();
  const shell = useShell();
  const t = seoText(locale);
  const id = useId();
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const overview = useResource<SeoOverview>(seoPath(project.id));
  const [note, setNote] = useState(() => {
    if (params.get("connection") === "connected")
      return { kind: "success" as const, text: t.connected };
    if (params.get("connection") === "error")
      return { kind: "error" as const, text: t.connectFailed };
    return null;
  });
  const [addOpen, setAddOpen] = useState(false);
  const [linking, setLinking] = useState<SeoWebsite | null>(null);
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  const mutation = useMutation();
  const busy = mutation.pending || redirecting;
  const availableProviders =
    overview.data?.providers.filter(
      (provider) =>
        provider.appReady &&
        provider.connections.some((connection) => !connection.unavailable),
    ) ?? [];

  useEffect(() => {
    if (!params.has("connection")) return;
    const rest = new URLSearchParams(params.toString());
    rest.delete("connection");
    router.replace(rest.size ? `${pathname}?${rest}` : pathname, {
      scroll: false,
    });
  }, [params, pathname, router]);

  useEffect(() => {
    const reset = () => setRedirecting(false);
    window.addEventListener("pageshow", reset);
    return () => window.removeEventListener("pageshow", reset);
  }, []);

  function closeDialog() {
    setAddOpen(false);
    setLinking(null);
    setConfirm(null);
    setDialogError(null);
  }

  function run(task: () => Promise<unknown>, success?: string, dialog = false) {
    void mutation.run(async () => {
      setNote(null);
      setDialogError(null);
      try {
        await task();
        if (success) {
          setNote({ kind: "success", text: success });
          setAddOpen(false);
          setConfirm(null);
          setLinking(null);
          overview.refresh();
        }
      } catch (error) {
        const text = seoError(error, t);
        if (dialog) setDialogError(text);
        else setNote({ kind: "error", text });
        throw new MutationCanceled();
      }
    });
  }

  function connect(providerId: string, connectionId?: string) {
    run(async () => {
      const response = await post<{ authorizeUrl: string }>(
        seoPath(project.id, `${providerPath(providerId)}/connect`),
        connectionId ? { connectionId } : {},
      );
      const target = new URL(response.authorizeUrl);
      if (target.protocol !== "https:")
        throw new Error("Invalid OAuth authorization URL");
      window.location.assign(target.href);
      setRedirecting(true);
    });
  }

  return (
    <div className={styles.page}>
      <PageHead title={t.manage} description={t.manageDescription}>
        <Button variant="outline" asChild>
          <AppLink href={shell.hrefOf("seo")}>SEO</AppLink>
        </Button>
      </PageHead>
      {note && overview.data?.canManage && (
        <Alert kind={note.kind}>{note.text}</Alert>
      )}
      {overview.error && (
        <SeoRequestError error={overview.error} retry={overview.refresh} />
      )}
      {overview.loading && <Loading label={t.loading} />}
      {overview.data && !overview.data.canManage && <Alert>{t.readonly}</Alert>}
      {overview.data?.canManage && (
        <>
          <section className="panel" aria-labelledby={`${id}-websites`}>
            <div className="panel-head">
              <h2 id={`${id}-websites`}>{t.websites}</h2>
              <Button disabled={busy} onClick={() => setAddOpen(true)}>
                {t.addWebsite}
              </Button>
            </div>
            <div className="panel-body">
              {overview.data.websites.length === 0 ? (
                <Empty
                  icon={Globe}
                  title={t.noSites}
                  description={t.noSitesBody}
                />
              ) : (
                <ul className={styles.list}>
                  {overview.data.websites.map((website) => (
                    <li key={website.id} className={styles.row}>
                      <div>
                        <strong>{website.name}</strong>
                        <p className="field-hint">{website.url}</p>
                        {website.properties.length === 0 ? (
                          <p className="field-hint">{t.noLinks}</p>
                        ) : (
                          <ul className={styles.propertyList}>
                            {website.properties.map((property) => {
                              const provider = overview.data?.providers.find(
                                (item) => item.id === property.provider,
                              );
                              return (
                                <li
                                  key={property.provider}
                                  className={styles.actions}
                                >
                                  <span>
                                    {provider?.label ?? property.provider} ·{" "}
                                    {property.propertyId}
                                  </span>
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    disabled={busy}
                                    aria-label={`${t.unlink}: ${website.name} · ${property.propertyId}`}
                                    onClick={() =>
                                      setConfirm({
                                        title: `${t.unlink}: ${property.propertyId}`,
                                        description: t.unlinkHelp,
                                        label: t.unlink,
                                        path: propertyPath(
                                          website.id,
                                          property.provider,
                                        ),
                                      })
                                    }
                                  >
                                    {t.unlink}
                                  </Button>
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </div>
                      <div className={styles.actions}>
                        {availableProviders.length > 0 && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy}
                            aria-label={`${t.link}: ${website.name}`}
                            onClick={() => setLinking(website)}
                          >
                            {t.link}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={`${t.archive}: ${website.name}`}
                          onClick={() =>
                            setConfirm({
                              title: `${t.archive}: ${website.name}`,
                              description: t.archiveHelp,
                              label: t.archive,
                              path: websitePath(website.id),
                            })
                          }
                        >
                          {t.archive}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
          <section className="panel" aria-labelledby={`${id}-accounts`}>
            <div className="panel-head">
              <h2 id={`${id}-accounts`}>{t.connections}</h2>
            </div>
            <div className={`panel-body ${styles.body}`}>
              {overview.data.providers.map((provider) => (
                <div key={provider.id} className={styles.body}>
                  <h3>{provider.label}</h3>
                  {!provider.appReady && (
                    <Alert kind="warning">
                      <p>
                        {provider.canConnect
                          ? t.missingGrant
                          : t.missingConnection}
                      </p>
                      <AppLink
                        className="text-link"
                        href={shell.connectionsHref()}
                      >
                        {t.projectConnections}
                      </AppLink>
                    </Alert>
                  )}
                  {provider.connections.length ? (
                    <ul className={styles.list}>
                      {provider.connections.map((connection) => (
                        <li key={connection.id} className={styles.row}>
                          <div className={styles.actions}>
                            <strong>{connection.label}</strong>
                            {connection.unavailable && (
                              <Badge tone="warning">
                                {t.connectionUnavailable}
                              </Badge>
                            )}
                          </div>
                          <div className={styles.actions}>
                            {provider.appReady && provider.canConnect && (
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={busy}
                                aria-label={`${t.reconnect}: ${connection.label}`}
                                onClick={() =>
                                  connect(provider.id, connection.id)
                                }
                              >
                                {t.reconnect}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy}
                              aria-label={`${t.disconnect}: ${connection.label}`}
                              onClick={() =>
                                setConfirm({
                                  title: `${t.disconnect}: ${connection.label}`,
                                  description: t.disconnectHelp,
                                  label: t.disconnect,
                                  path: connectionPath(
                                    provider.id,
                                    connection.id,
                                  ),
                                })
                              }
                            >
                              {t.disconnect}
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p>{t.noConnections}</p>
                  )}
                  {provider.appReady && provider.canConnect && (
                    <div className={styles.actions}>
                      <Button
                        disabled={busy}
                        onClick={() => connect(provider.id)}
                      >
                        {redirecting ? t.sending : t.connect}
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        </>
      )}
      {overview.data?.canManage && addOpen && (
        <AddWebsite
          pending={busy}
          onClose={closeDialog}
          error={dialogError}
          onAdd={(website) =>
            run(
              () => post(seoPath(project.id, "/websites"), website),
              t.websiteAdded,
              true,
            )
          }
        />
      )}
      {overview.data?.canManage && linking && (
        <LinkProperty
          website={linking}
          providers={availableProviders}
          pending={busy}
          onClose={closeDialog}
          error={dialogError}
          onLink={(providerId, binding) =>
            run(
              () =>
                put(
                  seoPath(project.id, propertyPath(linking.id, providerId)),
                  binding,
                ),
              t.saved,
              true,
            )
          }
        />
      )}
      {overview.data?.canManage && confirm && (
        <Modal
          title={confirm.title}
          description={confirm.description}
          onClose={closeDialog}
        >
          <div className={styles.body}>
            {dialogError && <Alert kind="error">{dialogError}</Alert>}
            <div className={styles.actions}>
              <Button variant="outline" onClick={closeDialog} disabled={busy}>
                {t.cancel}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() =>
                  run(
                    () => remove(seoPath(project.id, confirm.path)),
                    t.saved,
                    true,
                  )
                }
              >
                {confirm.label}
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
