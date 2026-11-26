import { ArrowDown, ArrowUp, Plus, RotateCcw, Send, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, message, type Feature, type ModelRef, type Source } from "./api";
import { Disclosure, Button, Copy, Drawer, Empty, Notice, Toggle } from "./components";
import { ModelSelector } from "./model-selector";
import type { RouteCandidateOrigin } from "../../../packages/db/routing-policy";

import { RouteHistory, type RouteVersionDetail } from "./route-history";
type Attempt = ModelRef & { origin: RouteCandidateOrigin };
type Preview = { attemptOrder: Attempt[]; excluded: (Attempt & { reason: string })[] };
const attemptOrigins: Record<RouteCandidateOrigin, string> = {
  feature: "Feature order",
  registration: "Registered model",
  environment: "Environment default",
};
const exclusionReasons: Record<string, string> = {
  model_unknown: "Missing from the source directory",
  candidate_limit: "Beyond the three-attempt limit",
  model_unavailable: "Source disabled or model delisted",
  credential_missing: "Source credential is missing",
  credential_expired: "Source requires reauthorization",
  endpoint_mismatch: "Endpoint is incompatible",
  context_mismatch: "Context window is too small",
  structured_output_mismatch: "Required structured output is unavailable",
  streaming_unknown: "Streaming support is unconfirmed",
  tools_unknown: "Tool support is unconfirmed",
  embedding_space_mismatch: "Embedding space differs",
  embedding_dimensions_mismatch: "Embedding dimensions differ",
  embedding_fallback_requires_matching_space_and_dimensions: "Embedding fallback requires matching space and dimensions",
};

export function routeModels(feature: Feature) {
  const saved = feature.routingPolicy;
  if (saved?.orderedModels) return saved.orderedModels;
  const first = saved?.primary ?? (saved?.fallbacks?.length ? feature.declaration.preferredModel : undefined);
  return [...(first ? [first] : []), ...(saved?.fallbacks ?? [])];
}

export function RouteEditor({ feature, sources, refresh }: { feature: Feature; sources: Source[]; refresh: () => Promise<void> }) {
  const [models, setModels] = useState(() => routeModels(feature).map((model) => ({ id: crypto.randomUUID(), model })));
  const [registrationPreference, setRegistrationPreference] = useState(feature.routingPolicy?.useRegistrationPreference !== false);
  const [preview, setPreview] = useState<Preview>();
  const [historyRevision, setHistoryRevision] = useState(0);
  const [rollback, setRollback] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [note, setNote] = useState("");
  const [active, setActive] = useState(feature.activeRouteVersion);
  const revision = useRef(feature.draftRevision);
  const url = `/features/${feature.id}/routing`;
  useEffect(() => { setActive(feature.activeRouteVersion); }, [feature.activeRouteVersion]);

  function changeModels(next: typeof models) {
    setModels(next);
    setPreview(undefined);
    setNote("");
  }
  const proposed = { orderedModels: models.map(({ model }) => model), useRegistrationPreference: registrationPreference };
  const previewRoute = () => api<Preview>(url + "/preview", "POST", proposed);
  async function review() {
    setBusy(true); setProblem("");
    try { setPreview(await previewRoute()); }
    catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  }

  async function waitForVersion(version: string) {
    for (let index = 0; index < 30; index++) {
      const pending = await api<RouteVersionDetail>(url + "/versions/" + version);
      setActive(pending.activeVersion);
      if (pending.state === "active") {
        setNote(pending.activeVersion === version ? `Version ${version} is live.` : `Version ${version} was published.`);
        await refresh();
        return;
      }
      if (pending.state === "failed" || pending.state === "superseded") {
        throw new Error(`Version ${version} was ${pending.state}${pending.errorCode ? " · " + pending.errorCode : ""}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    setNote(`Version ${version} is queued. Check Version history for its status.`);
  }

  async function save(publish: boolean) {
    setBusy(true); setProblem(""); setNote("");
    try {
      const draft = await api<{ draftRevision: number }>(url, "PUT", {
        expectedRevision: revision.current, policy: proposed,
      });
      revision.current = draft.draftRevision;
      if (publish) {
        const result = await api<{version: string}>(url + "/publish", "POST", { expectedRevision: revision.current });
        setHistoryRevision((value) => value + 1);
        try { await waitForVersion(result.version); }
        finally { setHistoryRevision((value) => value + 1); }
      } else {
        setPreview(await api<Preview>(url + "/preview", "POST"));
        setNote("Draft saved.");
      }
    } catch (error) { setProblem(message(error)); }
    finally { setBusy(false); }
  }

  const incomplete = models.some(({ model }) => !model.modelId || !model.sourceId);
  return <div className="route-editor" aria-busy={busy || undefined}>
    <div className="route-identity">
      <div><code>{feature.alias}</code><small>{active && !feature.unavailable ? `Serving version ${active}` : "No version is serving traffic"}</small></div>
      <Copy text={feature.alias}>Copy alias</Copy>
    </div>
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {note && <Notice clear={() => setNote("")}>{note}</Notice>}
    <section className="route-models" aria-labelledby="route-order">
      <div className="route-order-heading"><h3 id="route-order">Model order</h3>
        <Button variant="secondary" disabled={busy || models.length >= 13} onClick={() => changeModels([...models,
          { id: crypto.randomUUID(), model: { sourceId: "", modelId: "" } }])}><Plus size={16}/> Add model</Button></div>
      <p>The route can try up to three models. Environment defaults fill any open slots.</p>
      {models.length ? <ol className="route-order-list">
        {models.map(({ id, model }, index) => <li key={id}>
          <div className="route-order-row">
            <span className="route-position" aria-hidden="true">{index + 1}</span>
            <ModelSelector label={`Model ${index + 1}`} hideTitle disabled={busy} sources={sources} model={model} onChange={(next) =>
              changeModels(models.map((entry) => entry.id === id
                ? { id, model: next ?? { sourceId: "", modelId: "" } } : entry))}/>
            <div className="route-order-actions">
              {[-1, 1].map((offset) => {
                const position = index + offset;
                const direction = offset === -1 ? "up" : "down";
                const Icon = offset === -1 ? ArrowUp : ArrowDown;
                return <Button key={offset} variant="icon" title={`Move ${direction}`} aria-label={`Move model ${index + 1} ${direction}`}
                  disabled={busy || position < 0 || position >= models.length} onClick={() => {
                    const reordered = models.slice();
                    [reordered[index], reordered[position]] = [reordered[position], reordered[index]];
                    changeModels(reordered);
                  }}><Icon size={16}/></Button>;
              })}
              <Button variant="icon" className="route-remove" title="Remove model" aria-label={`Remove model ${index + 1}`}
                disabled={busy} onClick={() => changeModels(models.filter((entry) => entry.id !== id))}><Trash2 size={16}/></Button>
            </div>
          </div>
        </li>)}
      </ol> : <Toggle label="Try the registered model before environment defaults" checked={registrationPreference} disabled={busy}
        onChange={(event) => { setRegistrationPreference(event.target.checked); setPreview(undefined); setNote(""); }}/>}
      <div className="route-footer actions">
        <Button variant="secondary" disabled={busy || incomplete} onClick={() => void review()}>Preview order</Button>
        <Button variant="secondary" disabled={busy || incomplete} onClick={() => void save(false)}>Save draft</Button>
        <Button disabled={busy || incomplete || preview?.attemptOrder.length === 0} onClick={() => void save(true)}><Send size={16}/> {busy ? "Working…" : "Publish route"}</Button>
      </div>
      {preview && <section className="route-preview" aria-labelledby="route-preview-title" aria-live="polite">
        <h3 id="route-preview-title">Attempt order preview</h3>
        {preview.attemptOrder.length ? <ol className="route-preview-list" role="list">
          {preview.attemptOrder.map((model, index) => <li key={JSON.stringify([model.sourceId, model.modelId, index])}>
            <span className="route-preview-position" aria-hidden="true">{index + 1}</span>
            <span className="route-preview-model"><strong>{model.modelId}</strong><small>{model.sourceId}</small></span>
            <span className="route-preview-origin" data-origin={model.origin}>{attemptOrigins[model.origin]}</span>
          </li>)}
        </ol> : <Empty>No eligible models for this route.</Empty>}
        {!!preview.excluded.length && <Disclosure label={`Skipped models (${preview.excluded.length})`}>
          <ul className="route-preview-skipped">{preview.excluded.map((model) => <li key={JSON.stringify([model.sourceId, model.modelId, model.origin])}>
            <span className="route-preview-model"><strong>{model.modelId}</strong><small>{model.sourceId} · {attemptOrigins[model.origin]}</small></span>
            <small>{exclusionReasons[model.reason] ?? model.reason}</small>
          </li>)}</ul>
        </Disclosure>}
      </section>}
    </section>
    <RouteHistory url={url + "/versions"} active={active} busy={busy} refreshKey={historyRevision} restore={setRollback} sources={sources}/>
    {rollback && <Drawer kind="confirmation" title={`Roll back to version ${rollback}`} busy={busy} close={() => setRollback(undefined)}>
      <p>Minato will publish a new version using the selected route configuration and current model availability.</p>
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={busy} onClick={() => setRollback(undefined)}>Cancel</Button>
        <Button disabled={busy || !active} onClick={async () => {
          setBusy(true); setNote(""); setProblem("");
          try {
            const result = await api<{version: string}>(url + "/rollback", "POST", { version: rollback, expectedActiveVersion: active });
            setHistoryRevision((value) => value + 1);
            try { await waitForVersion(result.version); }
            finally { setHistoryRevision((value) => value + 1); }
          } catch (error) { setProblem(message(error)); }
          finally { setBusy(false); setRollback(undefined); }
        }}><RotateCcw size={16}/> Roll back</Button>
      </div>
    </Drawer>}
  </div>;
}
