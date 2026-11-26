import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { api, message } from "./api";
import { ButtonLink, Empty, Panel, Toggle } from "./components";

type DashboardAccess = { configured: boolean; enabled: boolean };

export function Dashboard({ alert }: { alert: (message: string) => void }) {
  const [access, setAccess] = useState<DashboardAccess>();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void api<DashboardAccess>("/dashboard").then((result) => {
      if (active) setAccess(result);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [reload]);

  async function toggle(enabled: boolean) {
    setSaving(true);
    try { setAccess(await api<DashboardAccess>("/dashboard", "PUT", { enabled })); }
    catch (error) { alert(message(error)); }
    finally { setSaving(false); }
  }

  return <Panel title="Dashboard access"><div className="dashboard-settings">
    {!access && (failed ? <Empty state="error" retry={() => { setFailed(false); setReload(reload + 1); }}>Dashboard access could not be loaded.</Empty>
      : <Empty state="loading">Loading Dashboard access…</Empty>)}
    {access && !access.configured && <Empty>Configure the Dashboard listener in your Minato deployment to manage access here.</Empty>}
    {access?.configured && <>
      <Toggle kind="switch" label="Allow administrator access" checked={access.enabled} disabled={saving}
        onChange={(event) => void toggle(event.target.checked)}/>
      {access.enabled && <ButtonLink href="/admin/v1/dashboard/open"
        target="_blank" rel="noopener"><ExternalLink aria-hidden="true" size={16}/> Open Dashboard</ButtonLink>}
    </>}
  </div></Panel>;
}
