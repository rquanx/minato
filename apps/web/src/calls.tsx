import { useEffect, useRef, useState } from "react";
import { ArrowRight, RotateCcw } from "lucide-react";
import { uploadEndpoints, endpointPaths } from "../../../packages/contracts/endpoints";
import { api, message, pretty, type Call, type Environment, type Feature } from "./api";
import { Disclosure, Field, Button, Copy, Drawer, Empty, Input, Pagination, Panel, Sections, Select, State, Table } from "./components";
import { CallFilters } from "./usage";

export type Replay = { replayOf: string; featureId: string; endpoint: string; input: string; response: unknown;
  model?: string; durationMs?: number; totalTokens?: string };
type CallDetails = { request_id: string; feature_id: string; endpoint: string; status: string; duration_ms?: number;
  attempts: Record<string, unknown>[]; alias: string };
type Content = { state: string; content: { kind: string; state: string; value: any }[] };
const detailSections = [{ id: "attempts", label: "Model attempts" }, { id: "request", label: "Request" }, { id: "response", label: "Response" }] as const;

export function Calls({ environment, features, alert, replay }: {
  environment?: Environment; features: Feature[]; alert: (value: string) => void; replay: (item: Replay) => void;
}) {
  const [result, setResult] = useState<{ items: Call[]; before?: string }>();
  const [pages, setPages] = useState([""]);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [range, setRange] = useState("24");
  const [status, setStatus] = useState("");
  const [advanced, setAdvanced] = useState<Record<string, string>>({});
  const [formVersion, setFormVersion] = useState(0);
  const [kind, setKind] = useState(() => new URLSearchParams(location.search).get("kind") ?? "");
  const [feature, setFeature] = useState(() => {
    const id = new URLSearchParams(location.search).get("featureId");
    return features.some((item) => item.id === id) ? id! : "";
  });
  const [selected, setSelected] = useState("");
  const [detail, setDetail] = useState<{ call: CallDetails; content: Content }>();
  const [section, setSection] = useState<"attempts" | "request" | "response">("attempts");
  const detailVersion = useRef(0);

  useEffect(() => {
    if (!environment) return;
    let current = true;
    setResult(undefined);
    setFailed(false);
    const query = new URLSearchParams({ ...advanced, limit: "25" });
    if (!query.has("requestId") && !query.has("correlationId") && !query.has("from") && !query.has("to")) {
      query.set("from", new Date(Date.now() - Number(range) * 3600000).toISOString());
    }
    if (status) query.set("status", status);
    const before = pages.at(-1);
    if (before) query.set("before", before);
    if (kind) query.set("kind", kind);
    if (feature) query.set("featureId", feature);
    void api<typeof result>(`/environments/${environment.id}/calls?${query}`).then((page) => {
      if (current) setResult(page);
    }).catch((error) => { if (current) { setFailed(true); alert(message(error)); } });
    return () => { current = false; };
  }, [environment?.id, kind, feature, status, range, advanced, pages, reload, alert]);

  function filter(name: "kind" | "featureId", value: string) {
    const url = new URL(location.href);
    if (value) url.searchParams.set(name, value);
    else url.searchParams.delete(name);
    history.replaceState(null, "", url);
    setResult(undefined);
    setPages([""]);
    if (name === "kind") setKind(value);
    else setFeature(value);
  }

  async function open(requestId: string) {
    const version = ++detailVersion.current;
    setSelected(requestId); setDetail(undefined); setSection("attempts");
    try {
      const [call, content] = await Promise.all([
        api<CallDetails>(`/calls/${requestId}`),
        api<Content>(`/calls/${requestId}/content`).catch(() => ({ state: "Content unavailable", content: [] })),
      ]);
      if (version === detailVersion.current) setDetail({ call, content });
    } catch (error) {
      if (version === detailVersion.current) { setSelected(""); alert(message(error)); }
    }
  }
  function close() { detailVersion.current++; setSelected(""); }

  if (!environment) return <Empty>Select an environment to inspect calls.</Empty>;
  const request = detail?.content.content.find(({ kind }) => kind === "request");
  const response = detail?.content.content.find(({ kind }) => kind === "response");
  const input = request?.value;
  const actual = detail?.call.attempts.findLast((attempt) => attempt.http_status === 200);
  const prompt = input === undefined ? "" : typeof input?.input === "string" && !input.instructions ? input.input
    : pretty(input?.messages ?? (input?.instructions ? { instructions: input.instructions, input: input.input } : input?.input));
  const next = result?.before;
  return <div className="page-stack">
    <div className="toolbar">
      <Select compact label="Time window" value={range} onValueChange={(value) => { setPages([""]); setRange(value); }}
        options={[{value:"1",label:"Last hour"},{value:"24",label:"Last 24 hours"},{value:"168",label:"Last 7 days"},{value:"720",label:"Last 30 days"}]}/>
      <CallFilters features={features} feature={feature} kind={kind} setFeature={(value) => filter("featureId", value)}
        setKind={(value) => filter("kind", value)}/>
      <Select compact label="Status" value={status} onValueChange={(value) => { setPages([""]); setStatus(value); }}
        options={[{value:"",label:"All statuses"},{value:"errors",label:"Errors and interruptions"},
          {value:"succeeded",label:"Succeeded"},{value:"failed",label:"Failed"},{value:"cancelled",label:"Cancelled"}]}/>
    </div>
    <Panel title="Find calls">
      <form key={formVersion} className="call-search" onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const next = Object.fromEntries(Array.from(fields, ([key, value]) => [key, String(value).trim()]).filter(([key, value]) => value && !(["endpoint", "fallback", "capture"].includes(key) && value === "any")));
        for (const key of ["from", "to"]) if (next[key]) next[key] = new Date(next[key]).toISOString();
        setResult(undefined); setPages([""]); setAdvanced(next);
      }}>
        <div className="call-search-grid">
          <Field label="Request ID">{(props) => <Input {...props} name="requestId" placeholder="Exact request UUID" pattern="[0-9a-fA-F-]{36}"/>}</Field>
          <Field label="Correlation ID">{(props) => <Input {...props} name="correlationId" placeholder="Order, job or trace ID" maxLength={128}/>}</Field>
          <Field label="Model">{(props) => <Input {...props} name="model" placeholder="Exact model ID" maxLength={256}/>}</Field>
          <Field label="Source">{(props) => <Input {...props} name="source" placeholder="Exact source slug" maxLength={160}/>}</Field>
        </div>
        <Disclosure label="More filters"><div className="call-search-grid">
          <Field label="From (local time)">{(props) => <Input {...props} type="datetime-local" name="from"/>}</Field>
          <Field label="To (local time)">{(props) => <Input {...props} type="datetime-local" name="to"/>}</Field>
          <Select name="endpoint" label="Endpoint" defaultValue="any" options={[
            {value:"any",label:"Any endpoint"}, ...Object.entries(endpointPaths).map(([value,label])=>({value,label})),
          ]}/>
          <Field label="Final HTTP status">{(props) => <Input {...props} type="number" name="httpStatus" min={100} max={599}/>}</Field>
          <Field label="Minimum latency (ms)">{(props) => <Input {...props} type="number" name="minDurationMs" min={0} max={2147483647}/>}</Field>
          <Field label="Minimum tokens">{(props) => <Input {...props} type="number" name="minTokens" min={0}/>}</Field>
          <Select label="Fallback" name="fallback" defaultValue="any" options={[
            {value:"any",label:"Any attempt count"},{value:"true",label:"Multiple attempts"},{value:"false",label:"No fallback"},
          ]}/>
          <Select label="Captured content" name="capture" defaultValue="any" options={[
            {value:"any",label:"Any capture state"},{value:"captured",label:"Captured"},{value:"partial",label:"Partial"},
            {value:"expired",label:"Expired"},{value:"disabled",label:"Disabled"},
          ]}/>
        </div></Disclosure>
        <div className="actions"><Button type="submit">Search</Button>
          <Button variant="secondary" onClick={() => { setAdvanced({}); setPages([""]); setFormVersion(formVersion + 1); }}>Clear search</Button>
        </div>
      </form>
    </Panel>
    <Panel title="Recent calls">
      {failed ? <Empty state="error" retry={() => setReload(reload + 1)}>Calls could not be loaded.</Empty>
        : !result ? <Empty state="loading">Loading calls…</Empty> : result.items.length ? <Table label="Recent calls">
        <thead><tr><th>Feature</th><th>Result model</th><th>Status</th><th>Time</th>
          <th className="cell-number">Latency</th><th className="cell-number">Tokens</th><th aria-label="Details"/></tr></thead>
        <tbody>{result.items.map((row) => <tr key={row.requestId}>
          <td><code>{row.alias}</code><small>{row.kind}{row.correlationId ? ` · ${row.correlationId}` : ""}</small></td>
          <td>{row.modelId ?? "—"}<small>{row.sourceId}{row.attemptCount > 1 ? ` · ${row.attemptCount} attempts` : ""}</small></td>
          <td><State value={row.status}/>{row.httpStatus && <small>HTTP {row.httpStatus}</small>}</td>
          <td className="cell-time">{new Date(row.startedAt).toLocaleString()}</td><td className="cell-number">{row.durationMs === null ? "—" : `${row.durationMs} ms`}</td>
          <td className="cell-number">{row.totalTokens === null ? "—" : BigInt(row.totalTokens).toLocaleString()}</td>
          <td><Button variant="icon" aria-label={`Open call ${row.requestId}`} onClick={() => void open(row.requestId)}><ArrowRight size={16}/></Button></td>
        </tr>)}</tbody></Table> : <Empty>No calls match these filters.</Empty>}
      {(pages.length > 1 || next) && <Pagination page={pages.length} disabled={!result && !failed}
        previous={pages.length > 1 ? () => { setResult(undefined); setPages((entries) => entries.slice(0, -1)); } : undefined}
        next={next ? () => { setResult(undefined); setPages((entries) => [...entries, next]); } : undefined}/>}
    </Panel>
    {selected && <Drawer title="Call details" close={close}>
      {!detail ? <Empty state="loading">Loading call details…</Empty> : <>
        <div className="actions"><State value={detail.call.status}/><code>{detail.call.request_id}</code></div>
        <div className="actions"><Copy text={prompt}>Copy prompt</Copy>
          <Copy text={input === undefined ? "" : pretty(input)}>Copy request JSON</Copy>
          <Button disabled={!input || request?.state === "truncated" || uploadEndpoints.has(detail.call.endpoint as keyof typeof endpointPaths)} onClick={() => replay({
            replayOf: detail.call.request_id, featureId: detail.call.feature_id, endpoint: detail.call.endpoint,
            input: pretty(input), response: response?.value,
            model: typeof actual?.model_id === "string" ? actual.model_id : undefined, durationMs: detail.call.duration_ms,
            totalTokens: typeof actual?.total_tokens === "string" ? actual.total_tokens : undefined,
          })}><RotateCcw size={15}/> Replay</Button></div>
        <Sections items={detailSections} active={section} onChange={setSection} label="Call details sections"/>
        {section === "attempts" && (detail.call.attempts.length ? <ul className="row-list">
          {detail.call.attempts.map((attempt) => <li key={String(attempt.id)}>
            <code>{String(attempt.source_id)} / {String(attempt.model_id)}</code><span>HTTP {String(attempt.http_status ?? "—")}</span>
            {typeof attempt.error_code === "string" && <small>{attempt.error_code.replaceAll("_", " ")}</small>}
            <span>{String(attempt.total_tokens ?? "Unknown")} tokens</span>
            {attempt.retryable === true && <State value="eligible_for_fallback"/>}
          </li>)}</ul> : <Empty>No model attempts were recorded.</Empty>)}
        {section === "request" && (input === undefined ? <Empty>{detail.content.state}</Empty> : <>
          <State value={request!.state}/><pre>{pretty(input)}</pre>
          {Array.isArray(input?.messages) && <ul className="row-list">{input.messages.map((item: { role?: string; content?: unknown }, index: number) =>
            <li key={index}><span>{item.role ?? "Message"}</span><Copy text={typeof item.content === "string" ? item.content : pretty(item.content)}>Copy message</Copy></li>)}</ul>}
        </>)}
        {section === "response" && (response ? <><State value={response.state}/><pre>{pretty(response.value)}</pre></> : <Empty>{detail.content.state}</Empty>)}
      </>}
    </Drawer>}
  </div>;
}
