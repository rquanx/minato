import { useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, message, pretty, type Source } from "./api";
import { Empty, Fields, Panel, State, value } from "./components";

export function Sources({ records, refresh, alert }: { records: Source[]; refresh: () => Promise<void>; alert: (text: string) => void }) {
  const [selected, setSelected] = useState<Source>();
  const [models, setModels] = useState<unknown[]>();
  return <div className="columns">
    <Panel title={selected ? `Edit ${selected.slug}` : "New source"}
      action={selected && <button className="button secondary" onClick={() => { setSelected(undefined); setModels(undefined); }}>New source</button>}>
      <Fields key={selected?.id ?? "new"} label={selected ? "Save source" : "Add source"} alert={alert} submit={async (form) => {
        const input = { kind: value(form, "kind"), directoryUrl: value(form, "directory"),
          apiBase: value(form, "base"), credentialEnv: value(form, "credential"),
          defaultEndpoint: value(form, "endpoint"), enabled: form.has("enabled") };
        if (selected) await api(`/sources/${selected.id}`, "PATCH", { ...input, expectedRevision: selected.revision });
        else await api("/sources", "POST", { ...input, slug: value(form, "slug") });
        setSelected(undefined); setModels(undefined); await refresh();
      }}>
        {!selected && <label>Source slug<input name="slug" required placeholder="example-provider"/></label>}
        <label>Provider<select name="kind" defaultValue={selected?.kind ?? "openai"}>
          <option value="openai">OpenAI compatible</option><option value="cpa">CLIProxyAPI</option>
          <option value="opencode-zen">OpenCode Zen</option><option value="opencode-go">OpenCode Go</option>
        </select></label>
        <label>Directory URL<input type="url" name="directory" required defaultValue={selected?.directoryUrl} placeholder="https://provider.example/v1/models"/></label>
        <label>Inference API base<input type="url" name="base" required defaultValue={selected?.apiBase} placeholder="https://provider.example/v1"/></label>
        <label>Credential environment variable<input name="credential" required defaultValue={selected?.credentialEnv} placeholder="MINATO_UPSTREAM_EXAMPLE"/></label>
        <label>Default endpoint<select name="endpoint" defaultValue={selected?.defaultEndpoint ?? "responses"}>
          <option value="responses">Responses</option><option value="chat-completions">Chat Completions</option>
        </select></label>
        <label className="toggle"><input type="checkbox" name="enabled" defaultChecked={selected?.enabled ?? true}/> Enabled</label>
      </Fields>
    </Panel>
    <Panel title="Model directories">{records.length ? <ul className="row-list">{records.map((source) => <li key={source.id}>
      <button className="text-button" onClick={async () => {
        setSelected(source); setModels(undefined);
        try { setModels(await api<unknown[]>(`/sources/${source.id}/models`)); } catch (error) { alert(message(error)); }
      }}>{source.slug}</button><State value={source.enabled ? source.syncState : "disabled"}/>
      {source.lastSuccessAt && <small>{new Date(source.lastSuccessAt).toLocaleString()}</small>}
      <button className="icon" aria-label={`Sync ${source.slug}`} disabled={!source.enabled} onClick={async () => {
        try { await api(`/sources/${source.id}/sync`, "POST"); await refresh(); alert("Directory sync queued."); }
        catch (error) { alert(message(error)); }
      }}><RefreshCw size={16}/></button></li>)}</ul> : <Empty>Add a source to discover available models.</Empty>}
      {models && <pre>{pretty(models)}</pre>}
    </Panel>
  </div>;
}
