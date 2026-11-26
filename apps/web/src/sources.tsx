import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { api, message, type Source } from "./api";
import { endpointPaths } from "../../../packages/contracts/endpoints";
import { browserSubscription, googleSubscription, providerDefaultEndpoints, providerUrls, subscriptionRelay, type ProviderKind } from "../../../packages/contracts/providers";
import { upstreamDescription } from "../../../packages/contracts/upstream-errors";
import { CpaAuthFiles } from "./cpa-auth-files";
import { SourceCredentials } from "./source-credentials";
import { SourceDiagnostics } from "./source-diagnostics";
import { Field, Button, Drawer, Empty, Fields, Input, Notice, Pagination, Panel, Sections, Select, State, Table, Textarea, Toggle, usePage, value } from "./components";

type Verification = { checkedAt: string; status: number | null; code: string | null; durationMs: number };
type Model = { modelId: string; status: string; reported?: { upstreamEndpoint?: string; protocolUnsupported?: boolean };
  capabilityOverride?: { upstreamEndpoint?: string; inputPricePerMillion?: number; outputPricePerMillion?: number; priceCurrency?: string };
  verification?: Verification | null; manual?: boolean };
const sections = [{ id: "models", label: "Models" }, { id: "diagnostics", label: "Diagnostics" }, { id: "settings", label: "Settings" }] as const;
const cpaSections = [...sections, { id: "auth", label: "Authentication files" }] as const;
const directSections = [...sections, { id: "credential", label: "Credentials" }] as const;
const endpointOptions = Object.entries(endpointPaths).map(([value, label]) => ({ value, label }));

const providerLabels: Record<ProviderKind, string> = {
  openai: "OpenAI compatible",
  cpa: "CLIProxyAPI",
  "opencode-zen": "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  vertex: "Google Vertex AI",
  codex: "Codex",
  claude: "Claude",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
  kimi: "Kimi Code",
};

function SourceEndpointFields({ source }: { source?: Source }) {
  const [kind, setKind] = useState<ProviderKind>(source?.kind ?? "openai");
  const [endpoint, setEndpoint] = useState(source?.defaultEndpoint ?? providerDefaultEndpoints[kind]);
  const [directory, setDirectory] = useState(source?.directoryUrl ?? "");
  const [base, setBase] = useState(source?.apiBase ?? "");
  const [authentication, setAuthentication] = useState("environment");
  const [directoryEnabled, setDirectoryEnabled] = useState(source?.directoryEnabled ?? true);

  return <><div className="form-row">
    <Select label="Provider" name="kind" value={kind}
      options={Object.entries(providerLabels).map(([value, label]) => ({ value, label }))}
      onValueChange={(value) => {
        const provider = value as ProviderKind;
        if (!directory || directory === providerUrls[kind]?.directory) setDirectory(providerUrls[provider]?.directory ?? "");
        if (!base || base === providerUrls[kind]?.base) setBase(providerUrls[provider]?.base ?? "");
        setKind(provider);
        setEndpoint(providerDefaultEndpoints[provider]);
        setAuthentication(provider === "vertex" ? "file" : provider === "codex" || subscriptionRelay(provider) ? "oauth" : "environment");
        if (!source) setDirectoryEnabled(provider !== "vertex" && !googleSubscription(provider));
      }}/>
    <Select label="Default endpoint" name="endpoint" value={endpoint} onValueChange={setEndpoint}
      options={endpointOptions}/>
  </div>
    {!source && kind !== "cpa" && <Select label="Authentication" name="authentication" value={authentication}
      onValueChange={setAuthentication} options={[
        ...(!["vertex", "codex"].includes(kind) && !subscriptionRelay(kind) ? [{ value: "environment", label: "Environment variable" }] : []),
        { value: "file", label: "Import authentication file" },
        ...(["openai", "codex", "kimi"].includes(kind) || browserSubscription(kind) ? [{ value: "oauth", label: "OAuth login" }] : []),
      ]}/>}
    <Field label="Directory URL">{(props) => <Input {...props} type="url" name="directory" value={directory}
      onChange={(event) => setDirectory(event.target.value)} placeholder="https://provider.example/v1/models"/>}</Field>
    <Field label="Inference API base">{(props) => <Input {...props} type="url" name="base" required value={base} onChange={(event) => setBase(event.target.value)}
      placeholder={kind === "vertex" ? "https://aiplatform.googleapis.com/v1/projects/PROJECT/locations/global/endpoints/openapi"
        : "https://provider.example/v1"}/>}</Field>
    <Toggle name="directoryEnabled" checked={directoryEnabled} disabled={googleSubscription(kind)} onChange={(event) => setDirectoryEnabled(event.target.checked)}
      label="Synchronize model directory"/>
  </>;
}

function ModelSettings({ source, model, update }: { source: Source; model: Model; update: (model: Model) => void }) {
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const [prompt, setPrompt] = useState("");
  const [sample, setSample] = useState("");
  const path = `/sources/${source.id}/models/${encodeURIComponent(model.modelId)}`;
  const overrideEndpoint = model.capabilityOverride?.upstreamEndpoint;
  const effective = overrideEndpoint ?? (!model.reported?.protocolUnsupported
    ? model.reported?.upstreamEndpoint ?? source.defaultEndpoint : undefined);
  const verification = model.verification;
  const textGeneration = effective && ["responses", "chat-completions", "completions", "anthropic-messages"].includes(effective);
  return <div className="page-stack">
    <div className="toolbar"><h3>{model.modelId}</h3><State value={model.status}/></div>
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    <Panel title="Endpoint">
      <Fields label="Save endpoint" alert={setProblem} submit={async (form) => {
        if (pending) return;
        const { upstreamEndpoint, ...other } = model.capabilityOverride ?? {};
        const chosen = value(form, "endpoint");
        const capabilityOverride = { ...other, ...(chosen ? { upstreamEndpoint: chosen } : {}) };
        await api(path, "PUT", capabilityOverride);
        update({ ...model, capabilityOverride, verification: chosen === (upstreamEndpoint ?? "") ? verification : null });
      }}>
        <Select label="Model endpoint" name="endpoint" disabled={pending} defaultValue={overrideEndpoint ?? ""}
          options={[{ value: "", label: "Automatic" }, ...endpointOptions]}/>
        <p className="field-hint">{effective
          ? `Effective endpoint ${endpointPaths[effective as keyof typeof endpointPaths]}`
          : "Set a supported endpoint to use this model."}</p>
      </Fields>
    </Panel>
    <Panel title="Availability" action={<Button variant="secondary" disabled={pending || !source.enabled || model.status !== "listed" || !effective}
      onClick={async () => {
        setPending(true); setProblem(""); setSample("");
        try {
          const { sample, ...verification } = await api<Verification & { sample?: string }>(path + "/verify", "POST",
            textGeneration && prompt.trim() ? { prompt: prompt.trim() } : {});
          update({ ...model, verification });
          setSample(sample ?? "");
        }
        catch (error) { setProblem(message(error)); }
        finally { setPending(false); }
      }}>{pending ? "Verifying…" : "Verify model"}</Button>}>
      {textGeneration && <Field label="Test prompt">{(props) => <Textarea {...props} value={prompt} onChange={(event) => setPrompt(event.target.value)}
        disabled={pending} maxLength={2000} placeholder="Reply with OK." rows={3}/>}</Field>}
      {verification ? <><State value={verification.code ? "failed" : "succeeded"}/>
        <p>{verification.code ? upstreamDescription(verification.code) : "The source accepted a synthetic request."}</p>
        <small>{new Date(verification.checkedAt).toLocaleString()} · {verification.durationMs} ms
          {verification.status !== null ? ` · HTTP ${verification.status}` : ""}</small></>
        : <Empty>Run a request to check availability. This uses upstream quota.</Empty>}
      {sample && <pre aria-label="Model response">{sample}</pre>}
    </Panel>
  </div>;
}

export function Sources({ records, refresh, alert }: { records: Source[]; refresh: () => Promise<void>; alert: (text: string) => void }) {
  const [selectedId, setSelectedId] = useState<string>();
  const [section, setSection] = useState<"models" | "diagnostics" | "settings" | "auth" | "credential">("models");
  const [models, setModels] = useState<Model[]>();
  const [problem, setProblem] = useState("");
  const [search, setSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [modelId, setModelId] = useState<string>();
  const [adding, setAdding] = useState(false);
  const [syncing, setSyncing] = useState("");
  const version = useRef(0);
  const selected = records.find((record) => record.id === selectedId);
  const selectedModel = models?.find((model) => model.modelId === modelId);
  const sourcePage = usePage(records.filter((source) => source.slug.toLowerCase().includes(search.trim().toLowerCase())));
  const modelPage = usePage((models ?? []).filter((model) => model.modelId.toLowerCase().includes(modelSearch.trim().toLowerCase())));
  const close = () => { version.current++; setSelectedId(undefined); setModelId(undefined); setAdding(false); };
  useEffect(() => {
    const url = new URL(window.location.href);
    const status = url.searchParams.get("oauth");
    if (!status) return;
    const id = url.searchParams.get("source");
    if (id) { setSelectedId(id); setSection("credential"); }
    alert(status === "connected" ? "Provider connected." : status === "cancelled" ? "Authorization cancelled." : "Provider authorization could not be completed.");
    url.searchParams.delete("oauth"); url.searchParams.delete("source");
    window.history.replaceState(null, "", url);
  }, []);
  async function open(source: Source) {
    const revision = ++version.current;
    setSelectedId(source.id); setSection("models"); setModels(undefined); setProblem(""); setModelSearch(""); setModelId(undefined); modelPage.reset();
    try {
      const loaded = await api<Model[]>(`/sources/${source.id}/models`);
      if (revision === version.current) setModels(loaded);
    } catch (error) { if (revision === version.current) setProblem(message(error)); }
  }

  return <div className="page-stack">
    <div className="toolbar"><Input aria-label="Search sources" type="search" placeholder="Search sources" value={search}
      onChange={(event) => { sourcePage.reset(); setSearch(event.target.value); }}/>
      <Button onClick={() => { setSelectedId("new"); setSection("settings"); setProblem(""); }}><Plus size={16}/> New source</Button></div>
    <Panel title="Model directories">
      {sourcePage.items.length ? <Table label="Model sources"><thead><tr><th>Source</th><th>Provider</th><th>Status</th><th>Last sync</th><th aria-label="Actions"/></tr></thead>
        <tbody>{sourcePage.items.map((source) => <tr key={source.id}>
          <td><Button variant="text" onClick={() => void open(source)}>{source.slug}</Button></td><td>{source.kind}</td>
          <td><State value={!source.enabled ? "disabled" : source.directoryEnabled === false ? "manual" : source.syncState}/></td>
          <td>{source.lastSuccessAt ? new Date(source.lastSuccessAt).toLocaleString() : "—"}</td>
          <td><Button variant="icon" aria-label={`Sync ${source.slug}`} disabled={!source.enabled || source.directoryEnabled === false || Boolean(syncing)}
            onClick={async () => {
              setSyncing(source.id);
              try { await api(`/sources/${source.id}/sync`, "POST"); await refresh(); alert("Directory sync queued."); }
              catch (error) { alert(message(error)); }
              finally { setSyncing(""); }
            }}><RefreshCw size={16}/></Button></td>
        </tr>)}</tbody></Table> : <Empty>{search ? "No sources match this search." : "Add a source to discover available models."}</Empty>}
      {sourcePage.controls.next || sourcePage.controls.previous ? <Pagination {...sourcePage.controls}/> : null}
    </Panel>
    {selectedId && <Drawer title={selected?.slug ?? "New source"} close={close}>
      {selected && <Sections items={selected.kind !== "cpa" ? directSections : selected.cpaManagement ? cpaSections : sections} active={section}
        onChange={(next) => { setModelId(undefined); setAdding(false); setSection(next); }} label="Source sections"/>}
      {section === "diagnostics" && selected && <SourceDiagnostics key={selected.id} sourceId={selected.id}/>}
      {section === "auth" && selected?.cpaManagement && <CpaAuthFiles sourceId={selected.id} alert={alert}/>}
      {section === "credential" && selected && <SourceCredentials source={selected} refresh={refresh} alert={alert}/>}
      {problem && section === "settings" && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
      {section === "models" && selected && selectedModel && <>
        <Button variant="text" onClick={() => setModelId(undefined)}><ArrowLeft size={16}/> Back to models</Button>
        <ModelSettings key={selectedModel.modelId} source={selected} model={selectedModel}
          update={(updated) => setModels((rows) => rows?.map((row) => row.modelId === updated.modelId ? updated : row))}/>
      </>}
      {section === "models" && !selectedModel && <>
        <div className="toolbar">
          <Input aria-label="Search models" type="search" placeholder="Search models" value={modelSearch}
            onChange={(event) => { modelPage.reset(); setModelSearch(event.target.value); }}/>
          {selected && <Button variant="secondary" onClick={() => setAdding((value) => !value)}>{adding ? "Cancel" : "Add model"}</Button>}
        </div>
        {adding && selected && <Panel title="Add a model by ID">
          {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
          <Fields label="Save model" alert={setProblem} submit={async (form) => {
            const modelId = value(form, "model");
            const upstreamEndpoint = value(form, "endpoint");
            const path = `/sources/${selected.id}/models`;
            await api(path, "POST", { modelId, ...(upstreamEndpoint ? { upstreamEndpoint } : {}) });
            setModels(await api<Model[]>(path)); setAdding(false); setProblem(""); setModelId(modelId.trim());
          }}>
            <Field label="Model ID">{(props) => <Input {...props} name="model" required maxLength={256}/>}</Field>
            <Select label="Model endpoint" name="endpoint" defaultValue=""
              options={[{ value: "", label: "Source default" }, ...endpointOptions]}/>
          </Fields>
        </Panel>}
        {models ? modelPage.items.length ? <Table label="Model directory">
          <thead><tr><th>Model</th><th>Directory</th><th>Availability</th><th>Input / output per 1M</th></tr></thead>
          <tbody>{modelPage.items.map((model) => {
            const price = model.capabilityOverride;
            return <tr key={model.modelId}>
              <td><Button variant="text" onClick={() => setModelId(model.modelId)}>{model.modelId}</Button></td>
              <td><State value={model.manual ? "manual" : model.status}/></td>
              <td>{model.verification ? <State value={model.verification.code ? "failed" : "succeeded"}/> : "Unchecked"}</td>
              <td>{price?.inputPricePerMillion !== undefined && price.outputPricePerMillion !== undefined
                ? `${price.inputPricePerMillion} / ${price.outputPricePerMillion} ${price.priceCurrency ?? "USD"}` : "—"}</td></tr>;
          })}</tbody></Table> : <Empty>No models match.</Empty>
          : problem ? <Empty state="error" retry={selected && (() => void open(selected))}>{problem}</Empty>
          : <Empty state="loading">Loading model directory…</Empty>}
        {modelPage.controls.next || modelPage.controls.previous ? <Pagination {...modelPage.controls}/> : null}
      </>}
      {section === "settings" && <Fields key={selectedId} label={selected ? "Save source" : "Add source"} alert={setProblem} submit={async (form) => {
        const input = { kind: value(form, "kind"), directoryUrl: value(form, "directory") || undefined,
          apiBase: value(form, "base"), credentialEnv: value(form, "credential") || null,
          defaultEndpoint: value(form, "endpoint"), enabled: form.has("enabled"), directoryEnabled: form.has("directoryEnabled") };
        if (selected) {
          await api(`/sources/${selected.id}`, "PATCH", { ...input, expectedRevision: selected.revision });
          await refresh(); close();
        } else {
          const authentication = value(form, "authentication");
          const direct = ["file", "oauth"].includes(authentication);
          const created = await api<{ id: string }>("/sources", "POST", { ...input,
            credentialEnv: direct ? null : input.credentialEnv, slug: value(form, "slug") });
          await refresh();
          if (direct) { setSelectedId(created.id); setSection("credential"); }
          else close();
        }
      }}>
        {!selected && <Field label="Source slug">{(props) => <Input {...props} name="slug" required placeholder="example-provider"/>}</Field>}
        <SourceEndpointFields source={selected}/>
        <Field label="Credential environment variable">{(props) => <Input {...props} name="credential" defaultValue={selected?.credentialEnv ?? ""}
          placeholder="MINATO_UPSTREAM_EXAMPLE"/>}</Field>
        <Toggle name="enabled" defaultChecked={selected?.enabled ?? true} label="Enabled"/>
      </Fields>}
    </Drawer>}
  </div>;
}
