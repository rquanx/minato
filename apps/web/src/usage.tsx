import { useEffect, useState } from "react";
import { api, memberSession, message, type Environment, type Feature, type Project } from "./api";
import { Button, Empty, Pagination, Panel, Sections, Select, Table, usePage } from "./components";

type Day = { date: string; requests: number; tokens: string | null; costKnownAttempts: number; estimatedCostUsd: string | null;
  errors: number; fallbacks: number; p95Ms: number | null };
type UsageTotals = { requestCount: number; attemptCount: number; unknownAttempts: number; knownTotalTokens: string;
  costKnownAttempts: number; estimatedCostUsd: string; costTrend: Day[];
  succeededCount: number; errorCount: number; fallbackCount: number; p50Ms: number | null; p95Ms: number | null;
  inputTokens: string; outputTokens: string; cachedTokens: string; reasoningTokens: string };
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 8 });
const number = new Intl.NumberFormat("en-US");
const views = [{ id: "charts", label: "Trends" }, { id: "table", label: "Daily breakdown" }, { id: "groups", label: "Breakdown by dimension" }] as const;
const dayFormat = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayLength = 86_400_000;
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 });
const ms = (value: number | null) => value === null ? "—" : `${number.format(value)} ms`;
const tokens = (value: string) => BigInt(value).toLocaleString("en-US");

function Trend({ title, days, read, format }: {
  title: string; days: Day[]; read: (day: Day) => number | null; format: (value: number) => string;
}) {
  const [hovered, setHovered] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const active = days.find((day) => day.date === hovered) ?? days.at(-1);
  const tabDay = days.find((day) => day.date === focused) ?? days.at(-1);
  const maximum = Math.max(0, ...days.map((day) => read(day) ?? 0));
  function describe(day: Day) {
    const value = read(day);
    return `${dayFormat.format(new Date(day.date))} · ${value === null ? "Unavailable" : format(value)}`;
  }
  const activeValue = active ? read(active) : null;
  return <section className="panel trend-card">
    <h2>{title}</h2>
    <div className="chart-value">
      <strong>{activeValue === null ? "Unavailable" : format(activeValue)}</strong>
      <span>{active ? dayFormat.format(new Date(active.date)) : "—"} · UTC</span>
    </div>
    <div className="chart" role="group" aria-label={title}>
      <div className="chart-scale" aria-hidden="true">
        <span>{maximum > 0 ? format(maximum) : "—"}</span><span>{format(0)}</span>
      </div>
      <div className="chart-bars">
      {days.map((day, index) => {
        const value = read(day);
        return <Button key={day.date} variant="text" className="chart-day" data-missing={value === null || undefined}
          data-active={active?.date === day.date || undefined} aria-label={describe(day)} tabIndex={tabDay?.date === day.date ? 0 : -1}
          onFocus={() => { setFocused(day.date); setHovered(day.date); }}
          onKeyDown={(event) => {
            const destinations: Record<string, number | undefined> = {
              ArrowLeft: index - 1, ArrowRight: index + 1, Home: 0, End: days.length - 1,
            };
            const target = destinations[event.key];
            if (target === undefined) return;
            event.preventDefault();
            event.currentTarget.parentElement?.querySelectorAll("button")[Math.max(0, Math.min(days.length - 1, target))]?.focus();
          }}
          onMouseEnter={() => setHovered(day.date)} onClick={() => setHovered(day.date)}>
          <span className="chart-track"><span style={{ height: value && maximum ? `${100 * value / maximum}%` : undefined }}/></span>
          <span className="chart-label" aria-hidden="true">{index === 0 || index === Math.floor((days.length - 1) / 2) || index === days.length - 1
            ? dayFormat.format(new Date(day.date)) : ""}</span>
        </Button>;
      })}
      </div>
    </div>
  </section>;
}

export function CallFilters({ features, feature, kind, setFeature, setKind }: {
  features: Feature[]; feature: string; kind: string; setFeature: (value: string) => void; setKind: (value: string) => void;
}) {
  return <>
    <Select compact label="Feature" value={feature} onValueChange={setFeature} options={[
      { value: "", label: "All features" }, ...features.map((item) => ({ value: item.id, label: item.declaration.displayName })),
    ]}/>
    <Select compact label="Call type" value={kind} onValueChange={setKind} options={[
      { value: "", label: "All call types" }, { value: "production", label: "Production" },
      { value: "test", label: "Test" }, { value: "replay", label: "Replay" },
    ]}/>
  </>;
}

export function Usage({ project, environment, features, alert }: {
  project?: Project; environment?: Environment; features: Feature[]; alert: (message: string) => void;
}) {
  const [range, setRange] = useState(7);
  const [feature, setFeature] = useState("");
  const [kind, setKind] = useState("");
  const [view, setView] = useState<(typeof views)[number]["id"]>("charts");
  const [data, setData] = useState<{ totals: UsageTotals; days: Day[]; query: string }>();
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [scope, setScope] = useState("environment");
  const usagePath = scope === "project" && project ? `/projects/${project.id}/usage`
    : environment ? `/environments/${environment.id}/usage` : undefined;
  const table = usePage(data?.days.slice().reverse() ?? []);
  useEffect(() => {
    if (!usagePath) return;
    let current = true;
    setData(undefined);
    setFailed(false);
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const from = today.getTime() - (range - 1) * dayLength;
    const query = new URLSearchParams({ from: new Date(from).toISOString() });
    if (feature) query.set("featureId", feature);
    if (kind) query.set("kind", kind);
    void api<UsageTotals>(`${usagePath}?${query}`).then((totals) => {
      if (!current) return;
      const byDate = new Map(totals.costTrend.map((day) => [day.date, day]));
      const days = Array.from({ length: range }, (_, index) => {
        const date = new Date(from + index * dayLength).toISOString().slice(0, 10);
        return byDate.get(date) ?? { date, requests: 0, tokens: "0", estimatedCostUsd: "0", costKnownAttempts: 0,
          errors: 0, fallbacks: 0, p95Ms: null };
      });
      setData({ totals, days, query: query.toString() });
    }).catch((error) => { if (current) { setFailed(true); alert(message(error)); } });
    return () => { current = false; };
  }, [usagePath, range, feature, kind, reload, alert]);
  if (!project && !environment) return <Empty>Select a project to view usage.</Empty>;
  const totals = data?.totals;
  return <div className="page-stack">
    <div className="toolbar">
      {!memberSession && <Select compact label="Usage scope" value={scope} onValueChange={(next) => {
        table.reset(); setFeature(""); setScope(next);
      }} options={[{ value: "environment", label: "Selected environment" }, { value: "project", label: "All project environments" }]}/>}
      <CallFilters features={scope === "project" ? [] : features} feature={feature} kind={kind}
        setFeature={(value) => { table.reset(); setFeature(value); }} setKind={(value) => { table.reset(); setKind(value); }}/>
      <Select compact label="Date range" value={String(range)} onValueChange={(value) => { table.reset(); setRange(Number(value)); }}
        options={[{ value: "1", label: "Today (UTC)" }, { value: "7", label: "Last 7 days" }, { value: "30", label: "Last 30 days" }]}/>
    </div>
    {totals && data ? <>
      <div className="metrics">{[
        ["Requests", number.format(totals.requestCount), `${number.format(totals.attemptCount)} model attempts`],
        ["Known tokens", tokens(totals.knownTotalTokens), `${tokens(totals.inputTokens)} input · ${tokens(totals.outputTokens)} output`],
        ["Estimated cost", totals.costKnownAttempts ? usd.format(Number(totals.estimatedCostUsd)) : "—", `${number.format(totals.costKnownAttempts)} priced attempts · USD`],
        ["Success rate", totals.succeededCount + totals.errorCount ? percent.format(totals.succeededCount / (totals.succeededCount + totals.errorCount)) : "—",
          `${number.format(totals.errorCount)} failed, cancelled or interrupted`],
        ["Latency p95", ms(totals.p95Ms), `Median ${ms(totals.p50Ms)} · end-to-end`],
        ["Calls with fallback", number.format(totals.fallbackCount),
          totals.requestCount ? percent.format(totals.fallbackCount / totals.requestCount) + " of requests" : "—"],
      ].map(([label, value, detail]) => <div key={label}><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>)}</div>
      <div className="usage-coverage">
        <span>{tokens(totals.cachedTokens)} cached input tokens</span><span>{tokens(totals.reasoningTokens)} reasoning tokens</span>
        <span>{number.format(totals.unknownAttempts)} attempts without token totals</span>
      </div>
      <Sections items={views} active={view} onChange={setView} label="Usage views"/>
      {!totals.requestCount && <Empty>No calls match this period and these filters.</Empty>}
      {view === "charts" ? <div className="usage-charts">
        <Trend title="Requests" days={data.days} read={(day) => day.requests} format={number.format}/>
        <Trend title="Known tokens" days={data.days} read={(day) => day.tokens === null ? null : Number(day.tokens)} format={number.format}/>
        <Trend title="Estimated cost (USD)" days={data.days} read={(day) => day.estimatedCostUsd === null ? null : Number(day.estimatedCostUsd)} format={usd.format}/>
        <Trend title="Unsuccessful calls" days={data.days} read={(day) => day.errors} format={number.format}/>
        <Trend title="Latency p95" days={data.days} read={(day) => day.p95Ms} format={ms}/>
        <Trend title="Calls with fallback" days={data.days} read={(day) => day.fallbacks} format={number.format}/>
      </div> : view === "groups" ? <UsageGroups key={data.query} path={`${usagePath}?${data.query}`}/>
        : <Panel title="Daily breakdown (UTC)">
        <Table label="Daily usage">
          <thead><tr><th>Date</th><th className="cell-number">Requests</th><th className="cell-number">Known tokens</th>
            <th className="cell-number">Estimated cost</th><th className="cell-number">Unsuccessful</th>
            <th className="cell-number">p95</th><th className="cell-number">Fallbacks</th></tr></thead>
          <tbody>{table.items.map((day) => <tr key={day.date}><td className="cell-time">{day.date}</td><td className="cell-number">{number.format(day.requests)}</td>
            <td className="cell-number">{day.tokens === null ? "Unavailable" : BigInt(day.tokens).toLocaleString("en-US")}</td>
            <td className="cell-number">{day.estimatedCostUsd === null ? "Unavailable" : usd.format(Number(day.estimatedCostUsd))}</td>
            <td className="cell-number">{number.format(day.errors)}</td><td className="cell-number">{ms(day.p95Ms)}</td>
            <td className="cell-number">{number.format(day.fallbacks)}</td></tr>)}</tbody>
        </Table><Pagination {...table.controls}/>
      </Panel>}
    </> : !usagePath ? <Empty>Select an environment or switch to project usage.</Empty>
      : failed ? <Empty state="error" retry={() => setReload(reload + 1)}>Usage could not be loaded.</Empty>
      : <Empty state="loading">Loading usage…</Empty>}
  </div>;
}

type UsageGroup = { label: string; detail: string | null; requests: number; attempts: number; tokens: string; estimatedCostUsd: string | null };

function UsageGroups({ path }: { path: string }) {
  const [group, setGroup] = useState("model");
  const [data, setData] = useState<UsageGroup[]>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const page = usePage(data ?? []);
  useEffect(() => {
    let current = true;
    setData(undefined);
    setError("");
    void api<{ groups: UsageGroup[] }>(`${path}&group=${group}`).then((result) => {
      if (current) setData(result.groups);
    }).catch((failure) => { if (current) setError(message(failure)); });
    return () => { current = false; };
  }, [group, path, reload]);
  return <Panel title="Top 100 by known tokens" action={<Select compact label="Group by" value={group}
    onValueChange={(value) => { page.reset(); setGroup(value); }} options={[
      { value: "model", label: "By model" }, { value: "source", label: "By source" },
      { value: "feature", label: "By feature" }, { value: "endpoint", label: "By endpoint" },
    ]}/>}>
    {error ? <Empty state="error" retry={() => setReload(reload + 1)}>{error}</Empty> : !data
      ? <Empty state="loading">Calculating breakdown…</Empty> : !data.length ? <Empty>No matching usage.</Empty> : <>
      {(group === "model" || group === "source") && <p className="usage-coverage">A request can appear in multiple rows when it tries more than one model or source.</p>}
      <Table label="Usage by dimension"><thead><tr><th>Group</th><th className="cell-number">Requests</th>
        <th className="cell-number">Attempts</th><th className="cell-number">Tokens</th><th className="cell-number">Estimated cost</th></tr></thead>
        <tbody>{page.items.map((row) => <tr key={JSON.stringify([row.label, row.detail])}><td>{row.detail ?? row.label}{row.detail && <small>{row.label}</small>}</td>
          <td className="cell-number">{number.format(row.requests)}</td><td className="cell-number">{number.format(row.attempts)}</td>
          <td className="cell-number">{tokens(row.tokens)}</td>
          <td className="cell-number">{row.estimatedCostUsd === null ? "—" : usd.format(Number(row.estimatedCostUsd))}</td></tr>)}</tbody>
      </Table>
      {data.length > 10 && <Pagination {...page.controls}/>}
    </>}
  </Panel>;
}
