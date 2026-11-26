import { useEffect, useState } from "react";
import { api, message } from "./api";
import { Button, ButtonLink, Field, Fields, Input, Notice, value } from "./components";

type Flow = { authorizationUrl: string; state: string };

export function BrowserOAuth({ sourceId, disabled, refresh, alert }: {
  sourceId: string; disabled?: boolean; refresh: () => Promise<void>; alert: (text: string) => void;
}) {
  const [flow, setFlow] = useState<Flow>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState("");
  const path = `/sources/${sourceId}/oauth`;
  useEffect(() => {
    if (!flow) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const { status } = await api<{ status: string }>(path + "/status?state=" + encodeURIComponent(flow!.state));
        if (!active) return;
        if (status === "connected") {
          setFlow(undefined); setProblem(""); await refresh(); alert("Provider connected."); return;
        }
        if (["expired", "cancelled", "failed"].includes(status)) {
          setFlow(undefined); setProblem(`Authorization ${status}. Start a new sign-in.`); return;
        }
      } catch (error) { if (active) setProblem(message(error)); }
      if (active) timer = setTimeout(poll, 1500);
    }
    timer = setTimeout(poll, 1500);
    return () => { active = false; clearTimeout(timer); };
  }, [flow, path]);
  return <div className="page-stack">
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {flow ? <>
      <div className="actions">
        <ButtonLink href={flow.authorizationUrl} target="_blank" rel="noreferrer">Open authorization page</ButtonLink>
        <Button variant="text" onClick={() => setFlow(undefined)}>Cancel</Button>
      </div>
      <Fields label="Complete authorization" alert={setProblem} submit={async (form) => {
        const result = await api<{ status: string }>(path + "/complete", "POST", { redirectUrl: value(form, "callback") });
        if (result.status !== "connected") throw new Error(`Authorization ${result.status}. Start a new sign-in.`);
        setFlow(undefined); setProblem(""); await refresh(); alert("Provider connected.");
      }}>
        <Field label="Callback URL" hint="If the callback page cannot open, copy its full address and paste it here.">
          {(props) => <Input {...props} name="callback" type="url" autoComplete="off" required/>}
        </Field>
      </Fields>
    </> : <div><Button variant="secondary" disabled={pending || disabled} onClick={async () => {
      setPending(true); setProblem("");
      try { setFlow(await api<Flow>(path, "POST")); }
      catch (error) { setProblem(message(error)); }
      finally { setPending(false); }
    }}>Sign in with browser</Button></div>}
  </div>;
}
