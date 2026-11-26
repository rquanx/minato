import { useEffect, useState } from "react";
import { Download, Plus } from "lucide-react";
import { api, message, type Source } from "./api";
import { Button, ButtonLink, Drawer, Empty, Input, Notice, Pagination, Panel, Select, State, Table, usePage } from "./components";
import { SourceCredentials } from "./source-credentials";

type AuthFile = { sourceId: string; source: string; provider: string; enabled: boolean; filename: string; importedAt: string; authType: string };
type Model = { modelId: string; status: string };
type Account = { id: string; label: string; provider: string; authType: string; refreshError?: string; sources: string[] | null };

function CredentialModels({ sourceId }: { sourceId: string }) {
  const [models, setModels] = useState<Model[]>();
  const [problem, setProblem] = useState("");
  const page = usePage(models ?? []);
  useEffect(() => {
    let current = true;
    void api<Model[]>(`/sources/${sourceId}/models`).then((rows) => {
      if (current) setModels(rows.filter((model) => model.status === "listed"));
    }).catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, [sourceId]);
  return <Panel title="Available models">
    {problem ? <Empty state="error">{problem}</Empty> : !models ? <Empty state="loading">Loading models…</Empty>
      : page.items.length ? <ul className="row-list">{page.items.map(({ modelId }) => <li key={modelId}>{modelId}</li>)}</ul>
      : <Empty>No listed models for this source.</Empty>}
    {(page.controls.next || page.controls.previous) && <Pagination {...page.controls}/>}
  </Panel>;
}

export function AuthenticationFiles({ sources, refresh, alert }: {
  sources: Source[]; refresh: () => Promise<void>; alert: (text: string) => void;
}) {
  const [files, setFiles] = useState<AuthFile[]>();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [removing, setRemoving] = useState<Account>();
  const [problem, setProblem] = useState("");
  const [search, setSearch] = useState("");
  const [drawer, setDrawer] = useState<"import" | "details">();
  const [sourceId, setSourceId] = useState("");
  const [pending, setPending] = useState(false);
  const [confirmToggle, setConfirmToggle] = useState(false);
  const [downloadPending, setDownloadPending] = useState(false);
  const direct = sources.filter((source) => source.kind !== "cpa");
  const selected = direct.find((source) => source.id === sourceId);
  const credential = files?.find((file) => file.sourceId === sourceId);
  const query = search.trim().toLowerCase();
  const page = usePage((files ?? []).filter((file) =>
    [file.filename, file.source, file.provider].some((field) => field.toLowerCase().includes(query))));
  const accountPage = usePage(accounts.filter((account) => [account.label, account.provider, ...(account.sources ?? [])]
    .some((field) => field.toLowerCase().includes(query))));
  async function load() {
    const [files, accounts] = await Promise.all([api<AuthFile[]>("/authentication-files"), api<Account[]>("/subscription-accounts")]);
    setFiles(files); setAccounts(accounts);
  }
  async function update() { await Promise.all([load(), refresh()]); }
  useEffect(() => {
    let current = true;
    void Promise.all([api<AuthFile[]>("/authentication-files"), api<Account[]>("/subscription-accounts")])
      .then(([files, accounts]) => { if (current) { setFiles(files); setAccounts(accounts); } })
      .catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, []);

  return <div className="page-stack">
    <div className="toolbar">
      <Input type="search" aria-label="Search authentication files" placeholder="Search files, sources or providers"
        value={search} onChange={(event) => { setSearch(event.target.value); page.reset(); accountPage.reset(); }}/>
      <Button onClick={() => { setSourceId(""); setDrawer("import"); }}><Plus size={16}/> Import file</Button>
    </div>
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {accountPage.items.length > 0 && <Panel title="Subscription accounts">
      <Table label="Subscription accounts">
        <thead><tr><th>Account</th><th>Provider</th><th>Authentication</th><th>Linked sources</th><th aria-label="Actions"/></tr></thead>
        <tbody>{accountPage.items.map((account) => <tr key={account.id}>
          <td>{account.label}</td><td>{account.provider}</td>
          <td><State value={account.refreshError ?? account.authType}/></td>
          <td>{account.sources?.join(", ") || "Unlinked"}</td>
          <td>{!account.sources?.length && <Button variant="secondary" onClick={() => setRemoving(account)}>Remove</Button>}</td>
        </tr>)}</tbody>
      </Table>
      {(accountPage.controls.next || accountPage.controls.previous) && <Pagination {...accountPage.controls}/>}
    </Panel>}
    {removing && <Drawer kind="confirmation" title="Remove subscription account?" busy={pending} close={() => setRemoving(undefined)}>
      <p>{removing.label} will no longer be available to link to a model source.</p>
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={pending} onClick={() => setRemoving(undefined)}>Cancel</Button>
        <Button variant="danger" disabled={pending} onClick={async () => {
          setPending(true);
          try { await api(`/subscription-accounts/${removing.id}`, "DELETE"); setRemoving(undefined); await update(); }
          catch (error) { alert(message(error)); }
          finally { setPending(false); }
        }}>Remove account</Button>
      </div>
    </Drawer>}
    <Panel title="Imported credentials">
      {page.items.length ? <Table label="Authentication files">
        <thead><tr><th>File</th><th>Source</th><th>Provider</th><th>Status</th><th>Imported</th></tr></thead>
        <tbody>{page.items.map((file) => <tr key={file.sourceId}>
          <td><Button variant="text" onClick={() => { setSourceId(file.sourceId); setDrawer("details"); }}>{file.filename}</Button></td>
          <td>{file.source}</td><td>{file.provider}</td><td><State value={file.enabled ? "enabled" : "disabled"}/></td>
          <td className="cell-time">{new Date(file.importedAt).toLocaleString()}</td>
        </tr>)}</tbody>
      </Table> : files ? <Empty>{query ? "No matching files." : "Import a credential for a direct model source."}</Empty>
        : problem ? <Empty state="error" retry={() => void load().then(() => setProblem("")).catch((error) => setProblem(message(error)))}>Could not load files.</Empty>
        : <Empty state="loading">Loading authentication files…</Empty>}
      {(page.controls.next || page.controls.previous) && <Pagination {...page.controls}/>}
    </Panel>
    {drawer && <Drawer title={drawer === "import" ? "Import authentication file" : credential?.filename ?? "Authentication file"}
      close={() => { setDrawer(undefined); setConfirmToggle(false); }}>
      <div className="page-stack">
        {drawer === "import" && (direct.length ? <Select label="Model source" placeholder="Select a source" value={sourceId}
          onValueChange={setSourceId} options={direct.map((source) => ({ value: source.id, label: source.slug }))}/>
          : <><Empty>Create a direct model source before importing its credential.</Empty>
            <div><ButtonLink href="/?view=sources">Open model sources</ButtonLink></div></>)}
        {selected && <>
          {drawer === "details" && credential && <>
            <div className="toolbar"><div><strong>{credential.source}</strong> · {credential.provider}</div><State value={credential.enabled ? "enabled" : "disabled"}/></div>
            <div className="actions">
              {credential.authType === "api_key" && <Button variant="secondary" disabled={downloadPending} onClick={async () => {
                setDownloadPending(true);
                try {
                  const data = await api<Record<string, string>>(`/sources/${selected.id}/credential/file`);
                  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
                  const link = document.createElement("a");
                  link.href = url; link.download = credential.filename; link.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                } catch (error) { alert(message(error)); }
                finally { setDownloadPending(false); }
              }}><Download size={16}/> Download</Button>}
              <Button variant="secondary" onClick={() => setConfirmToggle(true)}>{credential.enabled ? "Disable source" : "Enable source"}</Button>
            </div>
            <CredentialModels key={selected.id} sourceId={selected.id}/>
          </>}
          <Panel title={selected.managedCredential ? "Replace file" : "Upload file"}>
            <SourceCredentials key={selected.id} source={selected} refresh={update} alert={alert}/>
          </Panel>
        </>}
      </div>
    </Drawer>}
    {confirmToggle && selected && credential && <Drawer kind="confirmation"
      title={credential.enabled ? "Disable this source?" : "Enable this source?"} close={() => { if (!pending) setConfirmToggle(false); }}>
      <p>{credential.enabled ? "Routes using this source will switch to an eligible alternative or become unavailable."
        : "Minato will consider this source's models when updating routes."}</p>
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={pending} onClick={() => setConfirmToggle(false)}>Cancel</Button>
        <Button disabled={pending} onClick={async () => {
          setPending(true);
          try {
            await api(`/sources/${selected.id}/credential/status`, "PATCH", { enabled: !credential.enabled });
            await update();
            setConfirmToggle(false);
          } catch (error) { alert(message(error)); }
          finally { setPending(false); }
        }}>{credential.enabled ? "Disable source" : "Enable source"}</Button>
      </div>
    </Drawer>}
  </div>;
}
