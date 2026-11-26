import { useEffect, useState } from "react";
import { api, message, type Environment, type Project } from "./api";
import { Disclosure, Button, Drawer, Empty, Field, Fields, Input, Notice, Pagination, Panel, Sections, State, Table, Toggle, value } from "./components";

type Scope = "global" | "project" | "environment";
type Settings = { channels: string[] | null; inherited: string[]; available: string[]; channelNames: Record<string, string> };
type Webhook = { id: string; name: string; hostname: string; managed: boolean };
type EventPage = { before: string | null; items: {
  id: string; source: string; createdAt: string;
  payload: { status?: string; counts: Record<string, number>; changes: { kind: string; modelId: string }[] };
  deliveries: { channel: string; state: string; lastError?: string; scopes: { project: string; environment: string }[] }[];
}[] };
const tabs = [{ id: "events", label: "Activity" }, { id: "webhooks", label: "Webhooks" }, { id: "global", label: "Global channels" },
  { id: "project", label: "Project channels" }, { id: "environment", label: "Environment channels" }] as const;
const channelName = (value: string) => value === "in-app" ? "In-app" : value.replace(/^MINATO_NOTIFY_WEBHOOK_/, "");

export function Notifications({ project, environment }: { project?: Project; environment?: Environment }) {
  const [tab, setTab] = useState<"events" | "webhooks" | Scope>("events");
  const id = tab === "project" ? project?.id : tab === "environment" ? environment?.id : undefined;
  return <div className="page-stack">
    <Sections items={tabs} active={tab} onChange={setTab} label="Notification sections"/>
    {tab === "events" ? <Events/> : tab === "webhooks" ? <Webhooks/> : tab !== "global" && !id ? <Empty>Select a {tab} first.</Empty>
      : <ChannelSettings key={tab + (id ?? "")} scope={tab} id={id}/>}
  </div>;
}

function Webhooks() {
  const path = "/notifications/webhooks";
  const [items, setItems] = useState<Webhook[]>();
  const [editing, setEditing] = useState<Webhook | "new">();
  const [testing, setTesting] = useState<Webhook>();
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const [formError, setFormError] = useState("");
  async function load() {
    try { setItems(await api<Webhook[]>(path)); }
    catch (error) { setNotice({ text: message(error), error: true }); }
  }
  useEffect(() => { void load(); }, []);
  const selected = editing === "new" ? undefined : editing;
  return <Panel title="Webhook channels" action={<Button onClick={() => { setFormError(""); setEditing("new"); }}>Add Webhook</Button>}>
    <p className="webhook-help">Use channel settings to subscribe a global, project or environment scope after saving the destination.</p>
    {notice && <Notice tone={notice.error ? "error" : "info"} clear={() => setNotice(undefined)}>{notice.text}</Notice>}
    {!items ? <Empty state={notice?.error ? "error" : "loading"} retry={notice?.error ? load : undefined}>Webhook channels</Empty>
      : !items.length ? <Empty>Add a Webhook destination to send model change events.</Empty>
      : <Table label="Webhook channels"><thead><tr><th>Channel</th><th>Destination</th><th>Actions</th></tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}><td>{item.name}{!item.managed && <small>Deployment setting</small>}</td>
          <td>{item.hostname || "Invalid URL"}</td><td><div className="actions">
            {item.managed && <Button variant="secondary" onClick={() => { setFormError(""); setEditing(item); }}>Edit</Button>}
            <Button variant="secondary" disabled={!item.hostname || pending} onClick={() => setTesting(item)}>Send test</Button>
          </div></td></tr>)}</tbody></Table>}
    {editing && <Drawer title={selected ? "Edit Webhook" : "Add Webhook"} close={() => setEditing(undefined)}>
      {formError && <Notice tone="error">{formError}</Notice>}
      <Fields label="Save Webhook" alert={setFormError} submit={async (form) => {
        const url = value(form, "url");
        await api(selected ? path + "/" + encodeURIComponent(selected.id) : path, selected ? "PUT" : "POST",
          { name: value(form, "name"), ...(url ? { url } : {}) });
        setEditing(undefined);
        setNotice({ text: "Webhook saved." });
        await load();
      }}>
        <Field label="Channel name">{(props) => <Input {...props} name="name" required maxLength={80} defaultValue={selected?.name}/>}</Field>
        <Field label="HTTPS URL" hint={selected ? "Leave blank to keep the saved URL." : undefined}>
          {(props) => <Input {...props} name="url" type="url" required={!selected} maxLength={2048} autoComplete="off"/>}
        </Field>
      </Fields>
    </Drawer>}
    {testing && <Drawer kind="confirmation" busy={pending} title="Send a test event" close={() => setTesting(undefined)}>
      <p>Send one sample model change to <strong>{testing.name}</strong> at <code>{testing.hostname}</code>?</p>
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={pending} onClick={() => setTesting(undefined)}>Cancel</Button>
        <Button disabled={pending} onClick={async () => {
          setPending(true);
          try {
            const result = await api<{ ok: boolean; status: number }>(path + "/" + encodeURIComponent(testing.id) + "/test", "POST");
            setNotice({ text: `${testing.name} returned HTTP ${result.status}.`, error: !result.ok });
          } catch (error) { setNotice({ text: message(error), error: true }); }
          finally { setPending(false); setTesting(undefined); }
        }}>{pending ? "Sending…" : "Send test event"}</Button>
      </div>
    </Drawer>}
  </Panel>;
}

function Events() {
  const [cursors, setCursors] = useState<string[]>([]);
  const [data, setData] = useState<EventPage>();
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [retry, setRetry] = useState<{ event: string; channel: string }>();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState("");
  const before = cursors.at(-1);
  useEffect(() => {
    let current = true;
    const load = () => api<EventPage>(before ? `/notifications?before=${before}` : "/notifications")
      .then((result) => { if (current) { setData(result); setError(""); } })
      .catch((failure) => { if (current) setError(message(failure)); });
    void load();
    const timer = before ? undefined : window.setInterval(load, 15_000);
    return () => { current = false; window.clearInterval(timer); };
  }, [before, reload]);
  return <Panel title="Model changes">
    {error ? <Empty state="error" retry={() => setReload(reload + 1)}>{error}</Empty>
      : !data ? <Empty state="loading">Loading model changes…</Empty>
      : !data.items.length ? <Empty>Confirmed changes will appear here.</Empty>
      : <Table label="Model changes"><thead><tr><th>Source</th><th>Change</th><th>Delivery</th><th>Time</th></tr></thead>
        <tbody>{data.items.map((event) => <tr key={event.id}><td>{event.source}</td>
          <td>{event.payload.status && <State value={event.payload.status}/>}
            {Object.entries(event.payload.counts).map(([kind, count]) => <small key={kind}>{count} {kind}</small>)}
            {event.payload.changes.length > 0 && <Disclosure label="Models"><ul>
              {event.payload.changes.map((change) => <li key={change.kind + change.modelId}>{change.modelId} · {change.kind}</li>)}
            </ul></Disclosure>}
          </td>
          <td>{event.deliveries.map((delivery) => <div key={delivery.channel}>
            <small>{channelName(delivery.channel)} <State value={delivery.state}/></small>
            {delivery.lastError && <small>{delivery.lastError}</small>}
            {delivery.state === "failed" && <Button variant="secondary" onClick={() => {
              setRetryError(""); setRetry({ event: event.id, channel: delivery.channel });
            }}>Retry delivery</Button>}
          </div>)}</td>
          <td className="cell-time">{new Date(event.createdAt).toLocaleString()}</td>
        </tr>)}</tbody></Table>}
    {(before || data?.before) && <Pagination page={cursors.length + 1} disabled={!data && !error}
      previous={before ? () => { setData(undefined); setCursors(cursors.slice(0, -1)); } : undefined}
      next={data?.before ? () => { setCursors([...cursors, data.before!]); setData(undefined); } : undefined}/>}
    {retry && <Drawer kind="confirmation" busy={retrying} title="Retry delivery" close={() => setRetry(undefined)}>
      <p>Resend this event through {channelName(retry.channel)} to its current configured destination?</p>
      {retryError && <Notice tone="error">{retryError}</Notice>}
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={retrying} onClick={() => setRetry(undefined)}>Cancel</Button>
        <Button disabled={retrying} onClick={async () => {
          setRetrying(true);
          try {
            await api(`/notifications/${retry.event}/retry`, "POST", { channel: retry.channel });
            setRetry(undefined); setReload(reload + 1);
          } catch (failure) { setRetryError(message(failure)); }
          finally { setRetrying(false); }
        }}>Retry delivery</Button>
      </div>
    </Drawer>}
  </Panel>;
}

function ChannelSettings({ scope, id }: { scope: Scope; id?: string }) {
  const path = "/notifications/settings?" + new URLSearchParams({ scope, ...(id ? { id } : {}) });
  const [data, setData] = useState<Settings>();
  const [channels, setChannels] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let current = true;
    void api<Settings>(path).then((result) => {
      if (current) { setData(result); setChannels(result.channels); setError(""); }
    }).catch((failure) => { if (current) setError(message(failure)); });
    return () => { current = false; };
  }, [path, reload]);
  return <Panel title={tabs.find((item) => item.id === scope)!.label}>
    {!data ? error ? <Empty state="error" retry={() => setReload(reload + 1)}>{error}</Empty>
      : <Empty state="loading">Loading channels…</Empty> : <div className="channel-settings">
      {error && <Notice tone="error">{error}</Notice>}
      {saved && <Notice>Notification channels saved.</Notice>}
      {scope !== "global" && <Toggle label={scope === "project" ? "Inherit global channels" : "Inherit project channels"}
        checked={channels === null} disabled={saving} onChange={(event) => {
          setSaved(false); setChannels(event.target.checked ? null : data.inherited.filter((channel) => data.available.includes(channel)));
        }}/>}
      <div className="channel-list">{data.available.map((channel) => <Toggle key={channel} label={data.channelNames[channel] ?? channelName(channel)}
        checked={(channels ?? data.inherited).includes(channel)} disabled={saving || channels === null}
        onChange={(event) => {
          setSaved(false);
          setChannels(event.target.checked ? [...(channels ?? []), channel] : (channels ?? []).filter((entry) => entry !== channel));
        }}/>)}</div>
      <div><Button disabled={saving} onClick={async () => {
        setSaving(true); setError(""); setSaved(false);
        try {
          const result = await api<Settings>(path, "PUT", { channels });
          setData(result); setChannels(result.channels); setSaved(true);
        } catch (failure) { setError(message(failure)); }
        finally { setSaving(false); }
      }}>{saving ? "Saving…" : "Save channels"}</Button></div>
    </div>}
  </Panel>;
}
