import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import { api, message, type Environment, type Feature, type ModelRef, type Project, type Source } from "./api";
import { Button, Copy, Drawer, Empty, Field, Fields, Input, Notice, Pagination, Panel, Sections, State, Table, Toggle, usePage, value } from "./components";

import { RouteEditor } from "./route-editor";
import { ModelSelector } from "./model-selector";
import { Administration } from "./administration";

type Props = { project?: Project; environment?: Environment; features: Feature[];
  sources: Source[]; refresh: () => Promise<void>; alert: (text: string) => void };
type Key = { id: string; label: string; revokedAt?: string; expiresAt?: string };


const projectSections = [{ id: "routing", label: "Feature routing" }, { id: "defaults", label: "Default models" },
  { id: "keys", label: "Environment keys" }, { id: "audit", label: "Content audit" }, { id: "management", label: "Manage" }] as const;

export function Projects({ project, environment, features, sources, refresh, alert }: Props) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [secret, setSecret] = useState("");
  const [section, setSection] = useState<(typeof projectSections)[number]["id"]>("routing");
  const [create, setCreate] = useState<"project" | "environment">();
  const [editing, setEditing] = useState("");
  const [drawerNotice, setDrawerNotice] = useState("");
  const [revoking, setRevoking] = useState<Key>();
  const [revokePending, setRevokePending] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const selected = features.find((feature) => feature.id === editing);
  const featurePage = usePage(features);
  const keyPage = usePage(keys);
  const [audit, setAudit] = useState<{ enabled: boolean; revision: number; retentionDays: number; contentLimit: number; redactKeys: string[] }>();
  async function loadEnvironment(activeProject = project, activeEnv = environment) {
    if (!activeProject || !activeEnv) return;
    const prefix = `/projects/${activeProject.slug}/environments/${activeEnv.slug}`;
    const [records, policy] = await Promise.all([
      api<Key[]>(prefix + "/keys"), api<typeof audit>(`/environments/${activeEnv.id}/audit-policy`),
    ]);
    setKeys(records);
    setAudit(policy);
    setSettingsError("");
  }
  useEffect(() => {
    setSecret("");
    setAudit(undefined);
    setKeys([]);
    setSettingsError("");
    void loadEnvironment().catch((error) => setSettingsError(message(error)));
  }, [environment?.id]);
  function retrySettings() {
    setSettingsError("");
    void loadEnvironment().catch((error) => setSettingsError(message(error)));
  }
  const prefix = project && environment ? `/projects/${project.slug}/environments/${environment.slug}` : "";
  return <div className="page-stack">
    <div className="toolbar">
      <Button variant="secondary" disabled={!project} onClick={() => { setDrawerNotice(""); setCreate("environment"); }}>New environment</Button>
      <Button onClick={() => { setDrawerNotice(""); setCreate("project"); }}><Plus size={16}/> New project</Button>
    </div>
    {create && <Drawer title={create === "project" ? "Create project" : "Create environment"} close={() => setCreate(undefined)}>
      {drawerNotice && <Notice tone="error" clear={() => setDrawerNotice("")}>{drawerNotice}</Notice>}
      <Fields label={create === "project" ? "Create project" : "Create environment"} alert={setDrawerNotice} submit={async (form) => {
        const path = create === "project" ? "/projects" : `/projects/${project!.slug}/environments`;
        await api(path, "POST", { slug: value(form, "slug"), displayName: value(form, "name") });
        await refresh(); setCreate(undefined);
      }}><Field label={create === "project" ? "Project slug" : "Environment slug"}>{(props) =>
        <Input {...props} name="slug" required placeholder={create === "project" ? "demo-app" : "production"}/>}</Field>
        <Field label="Display name">{(props) => <Input {...props} name="name" required/>}</Field>
      </Fields>
    </Drawer>}
    {!environment && section !== "management" && <Empty>{project ? "Create an environment to configure routes and keys." : "Create a project to get started."}</Empty>}
    <Sections items={environment ? projectSections : projectSections.filter((entry) => entry.id === "routing" || entry.id === "management")}
      active={section} onChange={setSection} label="Project sections"/>
    {section === "management" && <Administration project={project} environment={environment} refresh={refresh}/>}
    {environment && <>
      {section === "keys" &&
      <Panel title="Environment keys">
        <Fields label="Issue key" alert={alert} submit={async (form) => {
          const key = await api<Key & { key: string }>(prefix + "/keys", "POST", { label: value(form, "label") });
          setSecret(key.key); await loadEnvironment();
        }}><Field label="Key label">{(props) => <Input {...props} name="label" required placeholder="Application server"/>}</Field></Fields>
        {secret && <div className="secret"><p>Copy this key now. It is shown only once.</p>
          <code>{secret}</code><div className="actions"><Copy text={secret}>Copy key</Copy>
            <Button variant="secondary" onClick={() => setSecret("")}>Hide key</Button></div></div>}
        {keys.length ? <ul className="row-list">{keyPage.items.map((key) => <li key={key.id}><KeyRound size={16} aria-hidden="true"/><span>{key.label}</span>
          <State value={key.revokedAt ? "revoked" : "active"}/>
          {!key.revokedAt && <Button variant="icon" title="Revoke key" aria-label={`Revoke ${key.label}`}
            onClick={() => { setDrawerNotice(""); setRevoking(key); }}><Trash2 size={16} aria-hidden="true"/></Button>}</li>)}</ul>
          : audit ? <Empty>No environment keys have been issued.</Empty>
          : settingsError ? <Empty state="error" retry={retrySettings}>{settingsError}</Empty>
          : <Empty state="loading">Loading environment keys…</Empty>}
        {keys.length > 10 && <Pagination {...keyPage.controls}/>}
      </Panel>}
      {section === "audit" && <Panel title="Content audit">{audit && <Fields key={audit.revision + "-" + environment.id} label="Save audit policy" alert={alert} submit={async (form) => {
        await api(`/environments/${environment.id}/audit-policy`, "PUT", {
          expectedRevision: audit.revision, enabled: form.has("enabled"), retentionDays: Number(form.get("days")),
          contentLimit: audit.contentLimit, redactKeys: value(form, "redact").split(",").map((part) => part.trim()).filter(Boolean),
        }); await loadEnvironment();
      }}><Toggle name="enabled" defaultChecked={audit.enabled} label="Store request and response content"/>
        <Field label="Retention in days">{(props) => <Input {...props} type="number" name="days" min="1" max="90" required defaultValue={audit.retentionDays}/>}</Field>
        <Field label="Fields to redact">{(props) => <Input {...props} name="redact" defaultValue={audit.redactKeys.join(", ")} placeholder="customer_id, email"/>}</Field>
      </Fields>}{!audit && (settingsError ? <Empty state="error" retry={retrySettings}>{settingsError}</Empty>
        : <Empty state="loading">Loading audit policy…</Empty>)}</Panel>}
      {revoking && <Drawer kind="confirmation" busy={revokePending} title="Revoke environment key" close={() => setRevoking(undefined)}>
        <p>Applications using <strong>{revoking.label}</strong> will lose access immediately.</p>
        {drawerNotice && <Notice tone="error">{drawerNotice}</Notice>}
        <div className="actions confirmation-actions">
          <Button variant="secondary" disabled={revokePending} onClick={() => setRevoking(undefined)}>Cancel</Button>
          <Button variant="danger" disabled={revokePending} onClick={async () => {
            setRevokePending(true); setDrawerNotice("");
            try {
              await api(prefix + "/keys/" + revoking.id, "DELETE");
              setRevoking(undefined);
              await loadEnvironment().catch((error) => alert(message(error)));
            } catch (error) { setDrawerNotice(message(error)); }
            finally { setRevokePending(false); }
          }}>{revokePending ? "Revoking…" : "Revoke key"}</Button>
        </div>
      </Drawer>}
      {section === "defaults" && <DefaultPool environmentId={environment.id} sources={sources} alert={alert}/>}
      {section === "routing" && <Panel title="Feature routing">{features.length ? <>
        <Table label="Feature routes"><thead><tr><th>Feature</th><th>Serving model</th><th>Route</th><th aria-label="Edit"/></tr></thead>
          <tbody>{featurePage.items.map((feature) => <tr key={feature.id}>
            <td>{feature.declaration.displayName}<small>{feature.alias}</small></td>
            <td>{feature.unavailable ? "—" : feature.activeModels?.[0]?.modelId ?? "—"}</td>
            <td><State value={feature.unavailable ? "unavailable" : feature.activeRouteVersion ? "active" : "pending"}/>
              {feature.routeReason && <small>{feature.routeReason.replaceAll("_", " ")}</small>}
              {feature.desiredRouteVersion !== feature.activeRouteVersion && feature.desiredRouteState && <small>Publication {feature.desiredRouteState}</small>}</td>
            <td><Button variant="secondary" onClick={() => { setDrawerNotice(""); setEditing(feature.id); }}>Configure</Button></td>
          </tr>)}</tbody></Table>
        {features.length > 10 && <Pagination {...featurePage.controls}/>}
      </> : <Empty>Register a feature with an environment key to configure a route.</Empty>}</Panel>}
      {selected && <Drawer title={selected.declaration.displayName} close={() => setEditing("")}>
        {drawerNotice && <Notice clear={() => setDrawerNotice("")}>{drawerNotice}</Notice>}
        <RouteEditor key={selected.id} feature={selected} sources={sources} refresh={refresh}/>
      </Drawer>}
    </>}
  </div>;
}

function DefaultPool({ environmentId, sources, alert }: { environmentId: string; sources: Source[]; alert: (text: string) => void }) {
  const [pool, setPool] = useState<ModelRef[]>([]);
  const [autoPublish, setAutoPublish] = useState<boolean>();
  const [saving, setSaving] = useState(false);
  const url = `/environments/${environmentId}/defaults`;
  useEffect(() => {
    let current = true;
    void api<{ pool: ModelRef[]; autoPublish: boolean }>(url).then((value) => {
      if (current) { setPool(value.pool); setAutoPublish(value.autoPublish); }
    })
      .catch((error) => { if (current) alert(message(error)); });
    return () => { current = false; };
  }, [url]);
  return <Panel title="Default model pool">
    <div className="route-options">
      {autoPublish !== undefined && <Toggle kind="switch" label="Automatically publish newly registered features"
        checked={autoPublish} disabled={saving} onChange={async (event) => {
          const enabled = event.target.checked;
          setSaving(true);
          try {
            const result = await api<{ autoPublish: boolean }>(`/environments/${environmentId}/auto-publish`, "PUT", { enabled });
            setAutoPublish(result.autoPublish);
          } catch (error) { alert(message(error)); }
          finally { setSaving(false); }
        }}/>}
      {pool.map((model, index) => <div key={index} className="route-row">
        <ModelSelector label={`Default ${index + 1}`} sources={sources} model={model} onChange={(change) => {
          if (change) setPool((previous) => previous.map((entry, i) => i === index ? change : entry));
        }}/>
        <Button variant="icon" aria-label="Remove default model" onClick={() => setPool((previous) => previous.filter((_, i) => i !== index))}>
          <Trash2 size={16}/>
        </Button>
      </div>)}
      <div className="actions">
        <Button variant="secondary" onClick={() => setPool((previous) => [...previous, { sourceId: "", modelId: "" }])}>
          <Plus size={16}/> Add default model
        </Button>
        <Button disabled={pool.some((model) => !model.modelId)} onClick={async () => {
          try { await api(url, "PUT", { pool }); alert("Default model pool saved."); }
          catch (error) { alert(message(error)); }
        }}>Save default pool</Button>
      </div>
    </div>
  </Panel>;
}
