import { useEffect, useState } from "react";
import { ArrowDown, ArrowRight, RotateCcw } from "lucide-react";
import { api, message, pretty, type Call, type Environment, type Feature } from "./api";
import { Copy, Empty, Panel, State } from "./components";

export type Replay = { replayOf: string; featureId: string; endpoint: string; input: string; response: unknown;
  model?: string; durationMs?: number; totalTokens?: string };
type CallDetails = { request_id: string; feature_id: string; endpoint: string; status: string; duration_ms?: number;
  attempts: Record<string, unknown>[]; alias: string };
type Content = { state: string; content: { kind: string; state: string; value: any }[] };
type Usage = { requestCount: number; attemptCount: number; unknownAttempts: number; knownTotalTokens: string };

export function Calls({ environment, features, view, alert, replay }: {
  environment?: Environment; features: Feature[]; view: "usage" | "calls"; alert: (value: string) => void; replay: (item: Replay) => void;
}) {
  const [rows, setRows] = useState<Call[]>([]);
  const [usage, setUsage] = useState<Usage>();
  const [cursor, setCursor] = useState("");
  const [kind, setKind] = useState(() => new URLSearchParams(location.search).get("kind") ?? "");
  const [feature, setFeature] = useState(() => new URLSearchParams(location.search).get("featureId") ?? "");
  const [selected, setSelected] = useState<CallDetails>();
  const [content, setContent] = useState<Content>();
  async function load(before = "") {
    if (!environment) return;
    const query = new URLSearchParams();
    if (kind) query.set("kind", kind);
    if (feature) query.set("featureId", feature);
    const url = `/environments/${environment.id}`;
    const totals = api<Usage>(url + "/usage?" + query);
    if (before) query.set("before", before);
    const records = api<{ items: Call[]; before?: string }>(url + "/calls?" + query);
    const [current, page] = await Promise.all([totals, records]);
    setUsage(current); setCursor(page.before ?? "");
    setRows((previous) => before ? [...previous, ...page.items] : page.items);
  }
  useEffect(() => { setSelected(undefined); setContent(undefined); void load().catch((error) => alert(message(error))); }, [environment?.id, kind, feature]);
  function filter(name: string, value: string) {
    const url = new URL(location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    history.replaceState(null, "", url);
    if (name === "kind") setKind(value);
    else setFeature(value);
  }
  async function open(requestId: string) {
    try {
      const details = await api<CallDetails>(`/calls/${requestId}`);
      const body = await api<Content>(`/calls/${requestId}/content`).catch(() => ({ state: "Content unavailable", content: [] }));
      setSelected(details); setContent(body);
    } catch (error) { alert(message(error)); }
  }
  if (!environment) return <Empty>Select an environment to inspect calls.</Empty>;
  const request = content?.content.find(({ kind }) => kind === "request");
  const response = content?.content.find(({ kind }) => kind === "response");
  const input = request?.value;
  const actual = selected?.attempts.findLast((attempt) => attempt.http_status === 200);
  const prompt = typeof input?.input === "string" && !input.instructions ? input.input
    : pretty(input?.messages ?? (input?.instructions ? { instructions: input.instructions, input: input.input } : input?.input));
  return <div className="page-stack">
    {view === "usage" && usage && <div className="metrics">{[
      ["Requests", usage.requestCount], ["Attempts", usage.attemptCount],
      ["Known tokens", usage.knownTotalTokens], ["Usage unavailable", usage.unknownAttempts],
    ].map(([label, value]) => <div key={label}><span>{label}</span><strong>{Number(value).toLocaleString()}</strong></div>)}</div>}
    <Panel title="Recent calls" action={<div className="actions">
      <select aria-label="Feature" value={feature} onChange={(event) => filter("featureId", event.target.value)}>
        <option value="">All features</option>
        {features.map((entry) => <option value={entry.id} key={entry.id}>{entry.declaration.displayName}</option>)}
      </select><select aria-label="Call type" value={kind} onChange={(event) => filter("kind", event.target.value)}>
      <option value="">All call types</option><option value="production">Production</option><option value="test">Test</option><option value="replay">Replay</option>
    </select></div>}>
      {rows.length ? <div className="table-scroll"><table><thead><tr><th>Feature</th><th>Status</th><th>Time</th><th>Tokens</th><th aria-label="Details"/></tr></thead>
        <tbody>{rows.map((row) => <tr key={row.requestId}><td><code>{row.alias}</code><small>{row.kind}</small></td>
          <td><State value={row.status}/></td><td>{new Date(row.startedAt).toLocaleString()}</td><td>{row.totalTokens ?? "Unknown"}</td>
          <td><button className="icon" aria-label={`Open call ${row.requestId}`} onClick={() => void open(row.requestId)}><ArrowRight size={16}/></button></td>
        </tr>)}</tbody></table></div> : <Empty>Calls will appear here after this environment sends traffic.</Empty>}
      {cursor && <button className="button secondary" onClick={() => void load(cursor).catch((error) => alert(message(error)))}><ArrowDown size={16}/> Older calls</button>}
    </Panel>
    {selected && <Panel title="Call details" action={<State value={selected.status}/>}>
      <p><code>{selected.request_id}</code></p>
      <div className="actions"><Copy text={prompt}>Copy prompt</Copy><Copy text={input === undefined ? "" : pretty(input)}>Copy request JSON</Copy>
        <button className="button" disabled={!input || request?.state === "truncated"} onClick={() => replay({
          replayOf: selected.request_id, featureId: selected.feature_id, endpoint: selected.endpoint,
          input: pretty(input), response: response?.value,
          model: typeof actual?.model_id === "string" ? actual.model_id : undefined, durationMs: selected.duration_ms,
          totalTokens: typeof actual?.total_tokens === "string" ? actual.total_tokens : undefined,
        })}><RotateCcw size={15}/> Replay</button></div>
      {Array.isArray(input?.messages) && <ul className="row-list">{input.messages.map((item: { role?: string; content?: unknown }, index: number) =>
        <li key={index}><span>{item.role ?? "Message"}</span><Copy text={typeof item.content === "string" ? item.content : pretty(item.content)}>Copy message</Copy></li>)}</ul>}
      <ul className="row-list">{selected.attempts.map((attempt) => <li key={String(attempt.id)}>
        <code>{String(attempt.source_id)} / {String(attempt.model_id)}</code><span>HTTP {String(attempt.http_status ?? "—")}</span>
        <span>{String(attempt.total_tokens ?? "Unknown")} tokens</span>
        {attempt.retryable === true && <State value="eligible_for_fallback"/>}
      </li>)}</ul>
      <div className="columns"><div><h3>Request {request && <State value={request.state}/>}</h3>
        {input !== undefined ? <pre>{pretty(input)}</pre> : <Empty>{content?.state ?? "Unavailable"}</Empty>}</div>
        <div><h3>Response {response && <State value={response.state}/>}</h3>
          {response ? <pre>{pretty(response.value)}</pre> : <Empty>{content?.state ?? "Unavailable"}</Empty>}</div></div>
    </Panel>}
  </div>;
}
