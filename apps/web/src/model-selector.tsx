import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { api, message, type ModelRef, type Source } from "./api";
import { Button, Drawer, Empty, Input, Pagination, Select, State, Table, usePage } from "./components";

export function ModelSelector({ label, hideTitle = false, disabled = false, sources, model, onChange }: {
  label: string; hideTitle?: boolean; disabled?: boolean; sources: Source[]; model?: ModelRef; onChange: (value: ModelRef | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [reload, setReload] = useState(0);
  const [models, setModels] = useState<{ modelId: string; status: string; verification?: { code: string | null } }[]>();
  const [problem, setProblem] = useState("");
  const source = sources.find((entry) => entry.slug === model?.sourceId);
  const page = usePage((models ?? []).filter((entry) => entry.modelId.toLowerCase().includes(query.trim().toLowerCase())));
  useEffect(() => {
    if (!open || !source) return;
    let current = true;
    setProblem(""); setModels(undefined);
    void api<typeof models>(`/sources/${source.id}/models`)
      .then((records) => { if (current) setModels(records); })
      .catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, [source?.id, open, reload]);
  return <div className="model-picker" role="group" aria-label={label}>{!hideTitle && <span className="field-label">{label}</span>}<div className="model-select">
    <Select compact disabled={disabled} label={label + " source"} value={model?.sourceId ?? ""} onValueChange={(sourceId) => {
      onChange(sourceId ? { sourceId, modelId: "" } : undefined);
    }} options={[{ value: "", label: "Select source" }, ...sources.map((entry) => ({ value: entry.slug, label: entry.slug }))]}/>
    <Button variant="secondary" className="model-picker-button" aria-label={label + " model"} disabled={disabled || !source}
      onClick={() => { setQuery(""); page.reset(); setOpen(true); }}>
      <span>{model?.modelId || "Select model"}</span><ChevronDown size={16}/>
    </Button></div>
    {open && source && <Drawer title={`Choose a model from ${source.slug}`} close={() => setOpen(false)}>
      <div className="page-stack">
        <Input type="search" aria-label="Search model IDs" placeholder="Search model IDs" value={query}
          onChange={(event) => { setQuery(event.target.value); page.reset(); }}/>
        {problem ? <Empty state="error" retry={() => setReload((value) => value + 1)}>{problem}</Empty>
          : !models ? <Empty state="loading">Loading models…</Empty> : page.items.length ? <Table label="Selectable models">
            <thead><tr><th>Model</th><th>Directory</th><th>Availability</th></tr></thead>
            <tbody>{page.items.map((entry) => <tr key={entry.modelId}>
              <td><Button variant="text" disabled={entry.status !== "listed"} onClick={() => {
                onChange({ sourceId: source.slug, modelId: entry.modelId }); setOpen(false);
              }}>{entry.modelId}</Button></td>
              <td><State value={entry.status}/></td>
              <td>{entry.verification ? <State value={entry.verification.code ? "failed" : "succeeded"}/> : "Unchecked"}</td>
            </tr>)}</tbody>
          </Table> : <Empty>No matching models.</Empty>}
        {(page.controls.next || page.controls.previous) && <Pagination {...page.controls}/>}
      </div>
    </Drawer>}
  </div>;
}
