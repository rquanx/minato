import { useEffect, useState } from "react";
import { api, message, type Environment, type Project } from "./api";
import { Button, Drawer, Empty, Field, Fields, Input, Notice, Panel, Select, Toggle, value } from "./components";

type Archived = { slug: string; displayName: string; project?: string };
type Member = { id: string; username: string };
type Grant = { id: string; usage: boolean; content: boolean; test: boolean };

export function Administration({ project, environment, refresh }: {
  project?: Project; environment?: Environment; refresh: () => Promise<void>;
}) {
  const [archive, setArchive] = useState<{ projects: Archived[]; environments: Archived[] }>();
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<{ name: string; path: string }>();
  const [pending, setPending] = useState(false);

  async function loadArchive() { setArchive(await api("/project-archives")); }
  useEffect(() => { void loadArchive().catch((error) => setProblem(message(error))); }, []);
  const path = project && "/projects/" + project.slug;
  const environmentPath = path && environment && path + "/environments/" + environment.slug;
  async function patch(target: string, body: object, success: string) {
    setProblem(""); setNotice(""); setPending(true);
    try {
      await api(target, "PATCH", body);
      setConfirmation(undefined);
      await Promise.all([refresh(), loadArchive()]);
      setNotice(success);
    } catch (error) { setProblem(message(error)); }
    finally { setPending(false); }
  }
  const entities = [
    ...(path && project ? [{ key: path, label: "Project", entity: project }] : []),
    ...(environmentPath && environment ? [{ key: environmentPath, label: "Environment", entity: environment }] : []),
  ];

  return <div className="page-stack">
    {problem && !confirmation && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {notice && <Notice clear={() => setNotice("")}>{notice}</Notice>}
    <div className="columns">{entities.map(({ key, label, entity }) => <Panel key={key} title={label}>
      <Fields label="Save display name" alert={setProblem} submit={async (data) =>
        patch(key, { displayName: value(data, "displayName") }, "Display name updated.")}>
        <Field label="Display name">{(props) => <Input {...props} key={entity.displayName} name="displayName" defaultValue={entity.displayName} required/>}</Field>
      </Fields>
      <div className="management-actions"><Button variant="secondary" disabled={pending} onClick={() => {
        setProblem(""); setConfirmation({ name: entity.displayName, path: key });
      }}>Archive {label.toLowerCase()}</Button></div>
    </Panel>)}</div>
    <Panel title="Archived resources">
      {archive && (archive.projects.length || archive.environments.length) ? <ul className="row-list">
        {[...archive.projects, ...archive.environments].map((entry) => {
          const target = entry.project ? `/projects/${entry.project}/environments/${entry.slug}` : `/projects/${entry.slug}`;
          return <li key={target}><span>{entry.displayName}</span><small>{entry.project ? `Environment · ${entry.project}` : "Project"}</small>
            <Button variant="secondary" disabled={pending} onClick={() => void patch(target, { archived: false }, "Resource restored.")}>Restore</Button></li>;
        })}
      </ul> : <Empty>{archive ? "No archived projects or environments." : "Loading archives…"}</Empty>}
    </Panel>
    {environment && <MemberAccess key={environment.id} environment={environment}/>}
    {confirmation && <Drawer kind="confirmation" title="Archive resource" busy={pending} close={() => setConfirmation(undefined)}>
      <p>Archive <strong>{confirmation.name}</strong>? Its environment keys will stop serving requests until it is restored.</p>
      {problem && <Notice tone="error">{problem}</Notice>}
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={pending} onClick={() => setConfirmation(undefined)}>Cancel</Button>
        <Button variant="danger" disabled={pending} onClick={() => void patch(confirmation.path, { archived: true }, "Resource archived.")}>Archive</Button>
      </div>
    </Drawer>}
  </div>;
}

function MemberAccess({ environment }: { environment: Environment }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [grants, setGrants] = useState<Grant[]>([]);
  const [selected, setSelected] = useState("");
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const path = `/environments/${environment.id}/members`;
  async function load() {
    const [list, access] = await Promise.all([api<Member[]>("/members"), api<Grant[]>(path)]);
    setMembers(list); setGrants(access);
  }
  useEffect(() => { void load().catch((error) => setProblem(message(error))); }, [path]);
  const grant = grants.find((item) => item.id === selected);
  const [usage, setUsage] = useState(true);
  return <Panel title="Environment access">
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {notice && <Notice clear={() => setNotice("")}>{notice}</Notice>}
    <div className="columns">
      <Fields label="Create member" alert={setProblem} submit={async (data) => {
        const member = await api<Member>("/members", "POST", { username: value(data, "username"), password: String(data.get("password") ?? "") });
        await load(); setSelected(member.id); setUsage(true); setNotice("Member created. Choose which permissions to grant.");
      }}>
        <Field label="Username">{(props) => <Input {...props} name="username" required autoComplete="off"/>}</Field>
        <Field label="Temporary password">{(props) => <Input {...props} name="password" minLength={12} type="password" required autoComplete="new-password"/>}</Field>
      </Fields>
      <div className="channel-settings">
        <Select label="Member" value={selected} onValueChange={(id) => {
          setSelected(id); setUsage(grants.find((item) => item.id === id)?.usage ?? true); setNotice("");
        }} options={members.map((member) => ({ value: member.id, label: member.username }))}/>
        {selected && <Fields key={selected} label="Save permissions" alert={setProblem} submit={async (data) => {
          await api(path + "/" + selected, "PUT", { usage, content: usage && data.has("content"), test: data.has("test") });
          await load(); setNotice("Permissions saved.");
        }}>
          <Toggle label="View usage and call metadata" checked={usage} onChange={(event) => setUsage(event.target.checked)}/>
          <Toggle label="Read captured content" name="content" defaultChecked={grant?.content} disabled={!usage}/>
          <Toggle label="Run tests" name="test" defaultChecked={grant?.test}/>
        </Fields>}
      </div>
    </div>
  </Panel>;
}
