import { useEffect, useState } from "react";
import { api, message, pretty, type Environment, type Feature, type ModelRef, type Source } from "./api";
import { Disclosure, Button, Select, Textarea, Empty, Field, Fields, Panel, State, Table, value } from "./components";
import { ModelSelector } from "./model-selector";
import type { Replay } from "./calls";
import { upstreamDescription } from "../../../packages/contracts/upstream-errors";

type TestResult = { id: string; status: string; output?: { response: unknown & { usage?: { total_tokens?: number } };
  actualModel?: string; durationMs?: number }; errorCode?: string;
  attempts?: { id: string; sourceId: string; modelId: string; status: number; durationMs: number; totalTokens: string | null;
    errorCode?: string | null; retryable?: boolean }[] };
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
  const [jsonError, setJsonError] = useState("");
  const selected = features.find((feature) => feature.id === featureId);
  const final = result?.attempts?.at(-1);
  useEffect(() => {
    if (!result || !["queued", "running"].includes(result.status)) return;
    let current = true;
    const timer = setTimeout(() => void api<TestResult>(`/tests/${result.id}`)
      .then((status) => { if (current) setResult(status); })
      .catch((error) => { if (current) alert(message(error)); }), 800);
    return () => { current = false; clearTimeout(timer); };
  }, [result]);
  if (!environment) return <Empty>Select an environment before testing.</Empty>;
  return <div className="test-workspace">
    <Panel title={input ? "Replay request" : "Request"} action={input && <Button variant="secondary" onClick={clear}>Start a new test</Button>}>
      <Fields label="Run test" alert={alert} submit={async (form) => {
        if (!selected) throw new Error("Select a feature");
        const specific = value(form, "target") === "specific";
        if (specific && !model?.modelId) throw new Error("Select a test model");
        let request: unknown;
        try { request = JSON.parse(draft); }
        catch {
          setJsonError("Enter valid JSON before running the test.");
          return;
        }
        await api<TestResult>(`/environments/${environment.id}/tests`, "POST", {
          featureId, endpoint: selected.declaration.requirements.endpoint, request, replayOf: input?.replayOf,
          target: specific ? { mode: "specific_model", ...model } : { mode: "active_route" },
        }, { "Idempotency-Key": crypto.randomUUID() }).then(setResult);
      }}>
        <div className="form-row">
        <Select label="Feature" placeholder="Select feature" value={featureId} onValueChange={setFeature}
          options={features.map((feature) => ({ value: feature.id, label: feature.alias }))}/>
        <Select label="Target" name="target" value={target} onValueChange={setTarget}
          options={[{ value: "current", label: "Current route" }, { value: "specific", label: "Specific model" }]}/>
        </div>
        {target === "specific" && <ModelSelector label="Specific model" sources={sources} model={model} onChange={setModel}/>}
        <Field label="Request JSON" error={jsonError}>{(props) => <Textarea {...props} className="code-input" spellCheck={false} value={draft}
          onChange={(event) => { setDraft(event.target.value); setJsonError(""); }} rows={10}/>}</Field>
      </Fields>
    </Panel>
    <Panel title="Results" action={result && <State value={result.status}/>}>
      <div className="test-results">
        <div><h3>Test response</h3>{result?.output ? <>
          <ResultSummary model={final?.modelId ?? result.output.actualModel} duration={result.output.durationMs}
            tokens={final?.totalTokens ?? result.output.response?.usage?.total_tokens}/><pre>{pretty(result.output.response)}</pre></>
          : <Empty state={result?.errorCode ? "error" : result && ["queued", "running"].includes(result.status) ? "loading" : "empty"}>
            {result?.errorCode ? upstreamDescription(result.errorCode) ?? result.errorCode.replaceAll("_", " ")
              : result ? "Waiting for the test result." : "Run a test to see its response."}
          </Empty>}</div>
        {!!result?.attempts?.length && <div><h3>Model attempts</h3>
          <Table label="Model attempts"><thead><tr><th>Model</th><th>HTTP</th><th>Latency</th><th>Tokens</th></tr></thead>
            <tbody>{result.attempts.map((attempt) => <tr key={attempt.id}>
              <td>{attempt.modelId}<small>{attempt.sourceId}</small>
                {attempt.errorCode && <small>{upstreamDescription(attempt.errorCode)}</small>}</td>
              <td className="cell-number">{attempt.status}</td>
              <td className="cell-number">{attempt.durationMs} ms</td>
              <td className="cell-number">{attempt.totalTokens ?? "—"}</td>
            </tr>)}</tbody>
          </Table>
        </div>}
        {input && <Disclosure label="Original response" open>
          <ResultSummary model={input.model} duration={input.durationMs} tokens={input.totalTokens}/>
          <pre>{pretty(input.response)}</pre></Disclosure>}
      </div>
    </Panel>
  </div>;
}
