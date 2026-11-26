import { useEffect, useState } from "react";
import { api, message } from "./api";
import { Button, Empty, FileField, Fields, Notice, Pagination, State, Table, usePage } from "./components";

type AuthFile = { name: string; provider?: string; status?: string; disabled?: boolean };

export function CpaAuthFiles({ sourceId, alert }: { sourceId: string; alert: (text: string) => void }) {
  const [files, setFiles] = useState<AuthFile[]>();
  const [problem, setProblem] = useState("");
  const [reload, setReload] = useState(0);
  const [fileRevision, setFileRevision] = useState(0);
  const page = usePage(files ?? []);
  const path = `/sources/${sourceId}/cpa-auth-files`;
  useEffect(() => {
    let current = true;
    setProblem("");
    void api<AuthFile[]>(path).then((result) => { if (current) setFiles(result); })
      .catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, [path, reload]);
  return <div className="page-stack">
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem} <Button variant="text" onClick={() => setReload((value) => value + 1)}>Retry</Button></Notice>}
    <Fields label="Import to CPA" alert={setProblem} submit={async (form) => {
      const file = form.get("credential");
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".json") || !file.size || file.size > 262_144) {
        throw new Error("Select one JSON credential file up to 256 KiB");
      }
      setProblem("");
      const result = await api<{ syncQueued: boolean }>(path, "POST", { name: file.name, content: await file.text() });
      setFileRevision((revision) => revision + 1);
      setReload((value) => value + 1);
      alert(result.syncQueued ? "Imported to CPA. Model sync queued." : "Imported to CPA.");
    }}>
      <FileField key={fileRevision} label="CPA authentication file" name="credential" required accept=".json,application/json"/>
    </Fields>
    {page.items.length ? <Table label="CPA authentication files">
      <thead><tr><th>File</th><th>Provider</th><th>Status</th></tr></thead>
      <tbody>{page.items.map((file) => <tr key={file.name}>
        <td>{file.name}</td><td>{file.provider ?? "—"}</td><td><State value={file.disabled ? "disabled" : file.status ?? "unknown"}/></td>
      </tr>)}</tbody>
    </Table> : files ? <Empty>No authentication files.</Empty> : !problem && <Empty state="loading">Loading authentication files…</Empty>}
    {(page.controls.next || page.controls.previous) && <Pagination {...page.controls}/>}
  </div>;
}
