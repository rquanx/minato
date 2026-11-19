import { useEffect, useState } from "react";
import { api, message, pretty, type Environment, type Feature, type ModelRef, type Source } from "./api";
import { Empty, Fields, Panel, State, value } from "./components";
import { ModelSelector } from "./projects";
import type { Replay } from "./calls";

type TestResult = { id: string; status: string; output?: { response: unknown & { usage?: { total_tokens?: number } };
  actualModel?: string; durationMs?: number }; errorCode?: string };
function ResultSummary({ model, duration, tokens }: { model?: string; duration?: number; tokens?: number | string }) {
  return <dl className="result-meta"><div><dt>Model</dt><dd>{model ?? "Unknown"}</dd></div>
    <div><dt>Latency</dt><dd>{duration === undefined ? "Unknown" : `${duration} ms`}</dd></div>
    <div><dt>Tokens</dt><dd>{tokens ?? "Unknown"}</dd></div></dl>;
}
export function ReplayEditor({ environment, features, sources, input, clear, alert }: {
  environment?: Environment; features: Feature[]; sources: Source[]; input?: Replay; clear: () => void; alert: (text: string) => void;
}) {
  const [draft, setDraft] = useState(input?.input ?? '{\n  "input": ""\n}');
  const [featureId, setFeature] = useState(input?.featureId ?? "");
  const [model, setModel] = useState<ModelRef>();
  const [target, setTarget] = useState("current");
  const [result, setResult] = useState<TestResult>();
  const selected = features.find((feature) => feature.id === featureId);
  useEffect(() => {
    if (!result || !["queued", "running"].includes(result.status)) return;
    const timer = setTimeout(() => void api<TestResult>(`/tests/${result.id}`).then(setResult).catch((error) => alert(message(error))), 800);
    return () => clearTimeout(timer);
  }, [result]);
  if (!environment) return <Empty>Select an environment before testing.</Empty>;
  return <div className="page-stack">
    <Panel title={input ? "Replay request" : "New test"} action={input && <button className="button secondary" onClick={clear}>Start a new test</button>}>
      <Fields label="Run test" alert={alert} submit={async (form) => {
        if (!selected) throw new Error("Select a feature");
        const specific = value(form, "target") === "specific";
        if (specific && !model?.modelId) throw new Error("Select a test model");
        const request = JSON.parse(draft);
        await api<TestResult>(`/environments/${environment.id}/tests`, "POST", {
          featureId, endpoint: selected.declaration.requirements.endpoint, request, replayOf: input?.replayOf,
          target: specific ? { mode: "specific_model", ...model } : { mode: "active_route" },
        }, { "Idempotency-Key": crypto.randomUUID() }).then(setResult);
      }}>
        <label>Feature<select required value={featureId} onChange={(event) => setFeature(event.target.value)}>
          <option value="">Select feature</option>{features.map((feature) => <option key={feature.id} value={feature.id}>{feature.alias}</option>)}
        </select></label>
        <label>Target<select name="target" value={target} onChange={(event) => setTarget(event.target.value)}><option value="current">Current route</option><option value="specific">Specific model</option></select></label>
        {target === "specific" && <ModelSelector label="Specific model" sources={sources} model={model} onChange={setModel}/>}
        <label>Request JSON<textarea spellCheck={false} value={draft} onChange={(event) => setDraft(event.target.value)} rows={10}/></label>
      </Fields>
    </Panel>
    {(input || result) && <Panel title="Results" action={result && <State value={result.status}/>}>
      <div className="columns">{input && <div><h3>Original response</h3>
        <ResultSummary model={input.model} duration={input.durationMs} tokens={input.totalTokens}/><pre>{pretty(input.response)}</pre></div>}
        <div><h3>Test response</h3>{result?.output ? <>
          <ResultSummary model={result.output.actualModel} duration={result.output.durationMs}
            tokens={result.output.response?.usage?.total_tokens}/><pre>{pretty(result.output.response)}</pre></>
          : <Empty>{result?.errorCode ?? (result ? "Waiting for the test result." : "Run the test to compare responses.")}</Empty>}</div></div>
    </Panel>}
  </div>;
}
