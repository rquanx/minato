import { useEffect, useState } from "react";
import { api, message } from "./api";
import { Button, ButtonLink, Copy, Notice } from "./components";

type Login = { sessionId: string; userCode: string; verificationUrl: string; interval: number; expiresAt: string };

export function CodexLogin({ sourceId, provider = "codex", refresh, alert }: {
  sourceId: string; provider?: "codex" | "kimi"; refresh: () => Promise<void>; alert: (text: string) => void;
}) {
  const [flow, setFlow] = useState<Login>();
  const [problem, setProblem] = useState("");
  const [pending, setPending] = useState(false);
  const path = `/sources/${sourceId}/${provider}-login`;
  const name = provider === "codex" ? "Codex" : "Kimi";
  useEffect(() => {
    if (!flow) return;
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      if (!flow || !current) return;
      try {
        const { status } = await api<{ status: string }>(path + "/" + flow.sessionId, "POST");
        if (!current) return;
        if (status === "connected") {
          setFlow(undefined); setProblem(""); await refresh(); alert(name + " connected."); return;
        }
        if (status === "expired" || Date.parse(flow.expiresAt) <= Date.now()) {
          setFlow(undefined); setProblem("The device code expired. Start a new sign-in."); return;
        }
        setProblem("");
      } catch (error) { if (current) setProblem(message(error)); }
      if (current) timer = setTimeout(poll, flow.interval * 1000);
    }
    timer = setTimeout(poll, flow.interval * 1000);
    return () => { current = false; clearTimeout(timer); };
  }, [flow, path]);
  return <div className="page-stack">
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {flow ? <>
      <p>Enter this code on the {name} sign-in page.</p>
      <div className="actions"><code>{flow.userCode}</code><Copy text={flow.userCode}>Copy code</Copy>
        <ButtonLink href={flow.verificationUrl} target="_blank" rel="noreferrer">Open {name} sign-in</ButtonLink>
        <Button variant="text" onClick={() => setFlow(undefined)}>Cancel</Button></div>
    </> : <div><Button variant="secondary" disabled={pending} onClick={async () => {
      setPending(true); setProblem("");
      try { setFlow(await api<Login>(path, "POST")); }
      catch (error) { setProblem(message(error)); }
      finally { setPending(false); }
    }}>{pending ? "Starting sign-in…" : "Sign in with device code"}</Button></div>}
  </div>;
}
