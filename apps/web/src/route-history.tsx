import { CalendarClock, Eye, RotateCcw, Route } from "lucide-react";
import { useEffect, useState } from "react";
import { api, message, type Feature, type ModelRef, type Source } from "./api";
import { Button, Disclosure, Drawer, Empty, Pagination, State, Table } from "./components";

type RouteVersion = { version: string; state: string; errorCode?: string; createdAt: string };
export type RouteVersionDetail = RouteVersion & {
  activeVersion: string | null; candidates: ModelRef[]; policy: Feature["routingPolicy"];
  requirements: Record<string, unknown>;
};
type HistoryPage = { items: RouteVersion[]; before: string | null };
const versionDate = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

export function RouteHistory({ url, active, busy, refreshKey, restore, sources }: {
  url: string; active: string | null; busy: boolean; refreshKey: number; restore: (version: string) => void; sources: Source[];
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<HistoryPage>();
  const [problem, setProblem] = useState("");
  const [retry, setRetry] = useState(0);
  const [viewing, setViewing] = useState<string>();
  const before = cursors.at(-1);
  const next = page?.before;

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams({ pageSize: "4" });
    if (before) query.set("before", before);
    setPage(undefined);
    setProblem("");
    void api<HistoryPage>(url + "?" + query).then((result) => { if (current) setPage(result); })
      .catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, [url, before, refreshKey, retry]);

  return <section className="route-history" aria-labelledby="route-history-title">
    <h3 id="route-history-title">Version history</h3>
    {problem ? <Empty state="error" retry={() => setRetry((value) => value + 1)}>{problem}</Empty>
      : !page ? <Empty state="loading">Loading versions…</Empty>
      : !page.items.length ? <Empty>No route versions yet.</Empty>
      : <><Table label="Route versions">
        <thead><tr><th scope="col">Version</th><th scope="col">Created</th><th scope="col">Status</th><th scope="col" aria-label="Actions"/></tr></thead>
        <tbody>{page.items.map((row) => <tr key={row.version}>
          <td className="cell-number">v{row.version}</td>
          <td><time dateTime={row.createdAt}>{versionDate.format(new Date(row.createdAt))}</time></td>
          <td><State value={row.version === active ? "serving" : row.state === "active" ? "published" : row.state}/>
            {row.errorCode && <small>{row.errorCode}</small>}</td>
          <td><div className="route-history-actions">
            <Button variant="icon" title="View configuration" aria-label={`View version ${row.version}`}
              onClick={() => setViewing(row.version)}><Eye size={16}/></Button>
            {row.state === "active" && row.version !== active && active && <Button variant="icon" title="Roll back to this version"
              aria-label={`Roll back to version ${row.version}`} disabled={busy} onClick={() => restore(row.version)}><RotateCcw size={16}/></Button>}
          </div></td>
        </tr>)}</tbody>
      </Table>
      {(before || page.before) && <Pagination page={cursors.length + 1}
        previous={before ? () => setCursors(cursors.slice(0, -1)) : undefined}
        next={next ? () => setCursors([...cursors, next]) : undefined}/>}</>}
    {viewing && <VersionConfiguration key={viewing} url={url + "/" + viewing} version={viewing}
      sources={sources} close={() => setViewing(undefined)}/>}
  </section>;
}

const requirementNames: Record<string, string> = {
  endpoint: "Endpoint", minContextTokens: "Minimum context tokens", structuredOutput: "Structured output",
  streaming: "Streaming", tools: "Tools", embeddingSpace: "Embedding space", embeddingDimensions: "Embedding dimensions",
};

function VersionConfiguration({ url, version, close, sources }: { url: string; version: string; close: () => void; sources: Source[] }) {
  const [details, setDetails] = useState<RouteVersionDetail>();
  const [problem, setProblem] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    setProblem("");
    void api<RouteVersionDetail>(url).then((result) => { if (current) setDetails(result); })
      .catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, [url, retry]);
  return <Drawer kind="modal" title={`Route version ${version}`} close={close}>
    <div className="route-version-details">
      {problem ? <Empty state="error" retry={() => setRetry((value) => value + 1)}>{problem}</Empty>
        : !details ? <Empty state="loading">Loading configuration…</Empty>
        : <VersionSnapshot details={details} sources={sources}/>}
    </div>
  </Drawer>;
}

function VersionSnapshot({ details, sources }: { details: RouteVersionDetail; sources: Source[] }) {
  const { policy, candidates, requirements } = details;
  const configured = (policy?.orderedModels ?? [policy?.primary, ...(policy?.fallbacks ?? [])].filter(
    (model): model is ModelRef => Boolean(model))).map((model) => ({
    ...model, sourceId: sources.find((source) => source.id === model.sourceId)?.slug ?? model.sourceId,
  }));
  const matches = (model: ModelRef, attempt?: ModelRef) => model.modelId === attempt?.modelId && model.sourceId === attempt.sourceId;
  const showConfigured = configured.some((model, index) => !matches(model, candidates[index]));
  const hasExplicitOrder = Boolean(policy?.orderedModels?.length || policy?.useRegistrationPreference === false || policy?.primary);
  const state = details.version === details.activeVersion ? "serving" : details.state === "active" ? "published" : details.state;

  return <>
    <div className="route-version-meta">
      <span><CalendarClock size={15} aria-hidden="true"/><time dateTime={details.createdAt}>{versionDate.format(new Date(details.createdAt))}</time></span>
      <State value={state}/>
    </div>
    <section className="route-version-flow">
      <h3><Route size={16} aria-hidden="true"/> Attempt order</h3>
      {!configured.length && policy && <p>{policy.useRegistrationPreference === false
        ? "Uses environment defaults" : "Tries the registered model before environment defaults"}</p>}
      <ol role="list">
        {candidates.map((model, index) => {
          const inFeature = configured.some((entry) => matches(entry, model));
          const origin = inFeature ? "Feature order" : hasExplicitOrder ? "Environment default" : undefined;
          return <li key={index}>
            <span className="route-version-step" aria-hidden="true">{index + 1}</span>
            <span className="route-preview-model"><strong>{model.modelId}</strong><small>{model.sourceId}</small></span>
            {origin && <span className="route-preview-origin" data-origin={inFeature ? "feature" : "environment"}>{origin}</span>}
          </li>;
        })}
      </ol>
    </section>
    {showConfigured && <Disclosure label="Configured model order">
      <ol className="route-version-configured">
        {configured.map((model, index) => <li key={index}>{model.modelId} <small>{model.sourceId}</small></li>)}
      </ol>
    </Disclosure>}
    <dl className="route-version-requirements" aria-label="Route requirements">
      {Object.entries(requirements).map(([name, value]) => <div key={name}>
        <dt>{requirementNames[name] ?? name}</dt>
        <dd>{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</dd>
      </div>)}
    </dl>
  </>;
}
