import { useEffect, useState } from "react";
import { ArrowDown, ArrowUp, KeyRound, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { api, message, pretty, type Environment, type Feature, type ModelRef, type Project, type Source } from "./api";
import { Copy, Empty, Fields, Panel, State, value } from "./components";

type Props = { project?: Project; environment?: Environment; features: Feature[];
  sources: Source[]; refresh: () => Promise<void>; alert: (text: string) => void };
type Key = { id: string; label: string; revokedAt?: string; expiresAt?: string };
type Policy = { primary?: ModelRef; fallbacks: ModelRef[] };
type Version = { version: string; state: string; errorCode?: string };

export function Projects({ project, environment, features, sources, refresh, alert }: Props) {
  const [keys, setKeys] = useState<Key[]>([]);
  const [secret, setSecret] = useState("");
  const [audit, setAudit] = useState<{ enabled: boolean; revision: number; retentionDays: number; contentLimit: number; redactKeys: string[] }>();
  async function loadEnvironment(activeProject = project, activeEnv = environment) {
    if (!activeProject || !activeEnv) return;
    const prefix = `/projects/${activeProject.slug}/environments/${activeEnv.slug}`;
    const [records, policy] = await Promise.all([
      api<Key[]>(prefix + "/keys"), api<typeof audit>(`/environments/${activeEnv.id}/audit-policy`),
    ]);
    setKeys(records);
    setAudit(policy);
  }
  useEffect(() => {
    setSecret("");
    setAudit(undefined);
    setKeys([]);
    void loadEnvironment().catch((error) => alert(message(error)));
  }, [environment?.id]);
  const prefix = project && environment ? `/projects/${project.slug}/environments/${environment.slug}` : "";
  return <div className="page-stack">
    <div className="columns">
      <Panel title="Create project"><Fields label="Create project" alert={alert} submit={async (form) => {
        await api("/projects", "POST", { slug: value(form, "slug"), displayName: value(form, "name") }); await refresh();
      }}><label>Project slug<input name="slug" required placeholder="demo-app"/></label>
        <label>Display name<input name="name" required placeholder="Demo application"/></label></Fields></Panel>
      <Panel title="Create environment">{project ?
        <Fields label="Create environment" alert={alert} submit={async (form) => {
          await api(`/projects/${project.slug}/environments`, "POST", { slug: value(form, "slug"), displayName: value(form, "name") }); await refresh();
        }}><label>Environment slug<input name="slug" required placeholder="production"/></label>
          <label>Display name<input name="name" required placeholder="Production"/></label></Fields> : <Empty>Select a project first.</Empty>}</Panel>
    </div>
    {environment && <><div className="columns">
      <Panel title="Environment keys">
        <Fields label="Issue key" alert={alert} submit={async (form) => {
          const key = await api<Key & { key: string }>(prefix + "/keys", "POST", { label: value(form, "label") });
          setSecret(key.key); await loadEnvironment();
        }}><label>Key label<input name="label" required placeholder="Application server"/></label></Fields>
        {secret && <div className="secret"><code>{secret}</code><Copy text={secret}>Copy key</Copy></div>}
        <ul className="row-list">{keys.map((key) => <li key={key.id}><KeyRound size={15}/><span>{key.label}</span>
          <State value={key.revokedAt ? "revoked" : "active"}/>
          {!key.revokedAt && <button type="button" className="icon" aria-label={`Revoke ${key.label}`} onClick={async () => {
            if (!window.confirm(`Revoke ${key.label}?`)) return;
            try { await api(prefix + "/keys/" + key.id, "DELETE"); await loadEnvironment(); } catch (error) { alert(message(error)); }
          }}><Trash2 size={16}/></button>}</li>)}</ul>
      </Panel>
      <Panel title="Content audit">{audit && <Fields key={audit.revision + "-" + environment.id} label="Save audit policy" alert={alert} submit={async (form) => {
        await api(`/environments/${environment.id}/audit-policy`, "PUT", {
          expectedRevision: audit.revision, enabled: form.has("enabled"), retentionDays: Number(form.get("days")),
          contentLimit: audit.contentLimit, redactKeys: value(form, "redact").split(",").map((part) => part.trim()).filter(Boolean),
        }); await loadEnvironment();
      }}><label className="toggle"><input type="checkbox" name="enabled" defaultChecked={audit.enabled}/> Store request and response content</label>
        <label>Retention in days<input type="number" name="days" min="1" max="90" required defaultValue={audit.retentionDays}/></label>
        <label>Fields to redact <input name="redact" defaultValue={audit.redactKeys.join(", ")} placeholder="customer_id, email"/></label>
      </Fields>}</Panel>
    </div>
    <DefaultPool environmentId={environment.id} sources={sources} alert={alert}/>
    <Panel title="Feature routing">{features.length ? features.map((feature) => <RouteEditor key={feature.id} feature={feature} sources={sources}
      refresh={refresh} alert={alert}/>) : <Empty>Register a feature with an environment key to configure a route.</Empty>}</Panel></>}
  </div>;
}

function DefaultPool({ environmentId, sources, alert }: { environmentId: string; sources: Source[]; alert: (text: string) => void }) {
  const [pool, setPool] = useState<ModelRef[]>([]);
  const url = `/environments/${environmentId}/defaults`;
  useEffect(() => {
    let current = true;
    void api<{ pool: ModelRef[] }>(url).then((value) => { if (current) setPool(value.pool); })
      .catch((error) => { if (current) alert(message(error)); });
    return () => { current = false; };
  }, [url]);
  return <Panel title="Default model pool">
    <div className="route-options">
      {pool.map((model, index) => <div key={index} className="route-row">
        <ModelSelector label={`Default ${index + 1}`} sources={sources} model={model} onChange={(change) => {
          if (change) setPool((previous) => previous.map((entry, i) => i === index ? change : entry));
        }}/>
        <button className="icon" aria-label="Remove default model" onClick={() => setPool((previous) => previous.filter((_, i) => i !== index))}>
          <Trash2 size={16}/>
        </button>
      </div>)}
      <div className="actions">
        <button className="button secondary" onClick={() => setPool((previous) => [...previous, { sourceId: "", modelId: "" }])}>
          <Plus size={16}/> Add default model
        </button>
        <button className="button" disabled={pool.some((model) => !model.modelId)} onClick={async () => {
          try { await api(url, "PUT", { pool }); alert("Default model pool saved."); }
          catch (error) { alert(message(error)); }
        }}>Save default pool</button>
      </div>
    </div>
  </Panel>;
}

function RouteEditor({ feature, sources, refresh, alert }: { feature: Feature; sources: Source[]; refresh: () => Promise<void>; alert: (text: string) => void }) {
  const [policy, setPolicy] = useState<Policy>({ primary: feature.routingPolicy?.primary, fallbacks: feature.routingPolicy?.fallbacks ?? [] });
  const [preview, setPreview] = useState<unknown>();
  const [versions, setVersions] = useState<Version[]>([]);
  const [opened, setOpened] = useState(false);
  const [rollback, setRollback] = useState("");
  const url = `/features/${feature.id}/routing`;
  async function updateVersions() { setVersions(await api<Version[]>(url + "/versions")); }
  useEffect(() => {
    if (!opened) return;
    const timer = setInterval(() => void updateVersions().catch(() => undefined), 2000);
    void updateVersions().catch((error) => alert(message(error)));
    return () => clearInterval(timer);
  }, [opened, url]);
  return <details onToggle={(event) => setOpened(event.currentTarget.open)} className="route">
    <summary><span>{feature.declaration.displayName}<code>{feature.alias}</code></span><State value={feature.activeRouteVersion ? "active" : "pending"}/></summary>
    <div className="route-body">
      <Copy text={feature.alias}>Copy alias</Copy>
      <div className="route-options">
        <ModelSelector label="Primary override" sources={sources} model={policy.primary} onChange={(primary) => setPolicy({ ...policy, primary })}/>
        {policy.fallbacks.map((model, index) => <div className="route-row" key={index}>
          <ModelSelector label={`Fallback ${index + 1}`} sources={sources} model={model} onChange={(entry) => {
            const fallbacks = policy.fallbacks.slice();
            if (entry) fallbacks[index] = entry;
            else fallbacks.splice(index, 1);
            setPolicy({ ...policy, fallbacks });
          }}/>
          {[-1, 1].map((offset) => <button key={offset} className="icon" aria-label={offset < 0 ? "Move fallback up" : "Move fallback down"}
            disabled={index + offset < 0 || index + offset >= policy.fallbacks.length} onClick={() => {
              const fallbacks = policy.fallbacks.slice();
              [fallbacks[index], fallbacks[index + offset]] = [fallbacks[index + offset], fallbacks[index]];
              setPolicy({ ...policy, fallbacks });
            }}>{offset < 0 ? <ArrowUp size={16}/> : <ArrowDown size={16}/>}</button>)}
          <button className="icon" aria-label="Remove fallback" onClick={() => setPolicy({ ...policy, fallbacks: policy.fallbacks.filter((_, i) => index !== i) })}><Trash2 size={16}/></button>
        </div>)}
        <button type="button" className="button secondary" onClick={() => setPolicy({ ...policy, fallbacks: [...policy.fallbacks, { sourceId: "", modelId: "" }] })}><Plus size={16}/> Add fallback</button>
      </div>
      <div className="actions">
        <button className="button secondary" onClick={async () => {
          try {
            await api(url, "PUT", { expectedRevision: feature.draftRevision, policy });
            setPreview(await api(url + "/preview", "POST")); await refresh();
          } catch (error) { alert(message(error)); }
        }}>Save and preview</button>
        <button className="button" onClick={async () => {
          try { await api(url + "/publish", "POST", { expectedRevision: feature.draftRevision }); await updateVersions(); await refresh(); }
          catch (error) { alert(message(error)); }
        }}><Send size={15}/> Publish saved route</button>
      </div>
      {preview !== undefined && <pre>{pretty(preview)}</pre>}
      <p>Serving version {versions.find((version) => version.state === "active")?.version ?? "—"}</p>
      <ul className="row-list">{versions.slice(0, 4).map((version) => <li key={version.version}>Version {version.version}<State value={version.state}/>{version.errorCode}</li>)}</ul>
      <div className="actions"><select value={rollback} aria-label="Previous route version" onChange={(event) => setRollback(event.target.value)}>
        <option value="">Previous route version</option>{versions.filter((entry) => entry.state === "active").map((entry) => <option key={entry.version} value={entry.version}>{entry.version}</option>)}
      </select><button className="button secondary" disabled={!rollback || !feature.activeRouteVersion} onClick={async () => {
        try { await api(url + "/rollback", "POST", { version: rollback, expectedActiveVersion: feature.activeRouteVersion }); await updateVersions(); await refresh(); }
        catch (error) { alert(message(error)); }
      }}><RotateCcw size={15}/> Roll back</button></div>
    </div>
  </details>;
}

export function ModelSelector({ label, sources, model, onChange }: {
  label: string; sources: Source[]; model?: ModelRef; onChange: (value: ModelRef | undefined) => void;
}) {
  const [models, setModels] = useState<{ modelId: string; status: string }[]>([]);
  const source = sources.find((entry) => entry.slug === model?.sourceId);
  useEffect(() => {
    let current = true;
    setModels([]);
    if (source) void api<typeof models>(`/sources/${source.id}/models`).then((records) => { if (current) setModels(records); }).catch(() => undefined);
    return () => { current = false; };
  }, [source?.id]);
  return <fieldset><legend>{label}</legend><div className="model-select">
    <select aria-label={label + " source"} value={model?.sourceId ?? ""} onChange={(event) => {
      const sourceId = event.target.value; onChange(sourceId ? { sourceId, modelId: "" } : undefined);
    }}><option value="">Select source</option>{sources.map((entry) => <option key={entry.id} value={entry.slug}>{entry.slug}</option>)}</select>
    <select aria-label={label + " model"} disabled={!source} value={model?.modelId ?? ""} onChange={(event) => {
      if (model) onChange({ ...model, modelId: event.target.value });
    }}><option value="">Select model</option>
      {model?.modelId && !models.some((entry) => entry.modelId === model.modelId) && <option>{model.modelId}</option>}
      {models.map((entry) => <option key={entry.modelId} value={entry.modelId}>{entry.modelId}{entry.status === "removed" ? " (removed)" : ""}</option>)}
    </select></div></fieldset>;
}
