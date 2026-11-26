import { useEffect, useState } from "react";
import { api, message, type Source } from "./api";
import { Button, Drawer, Field, FileField, Fields, Input, Notice, Select, State, value } from "./components";
import { CodexLogin } from "./codex-login";
import { BrowserOAuth } from "./browser-oauth";
import { browserSubscription, subscriptionRelay } from "../../../packages/contracts/providers";

type Account = { id: string; label: string; provider: string; filename?: string; sources: string[] | null };

export function SourceCredentials({ source, refresh, alert }: { source: Source; refresh: () => Promise<void>; alert: (text: string) => void }) {
  const [fileRevision, setFileRevision] = useState(0);
  const [problem, setProblem] = useState("");
  const [remove, setRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  useEffect(() => {
    let active = true;
    void api<Account[]>("/subscription-accounts").then((records) => { if (active) setAccounts(records); })
      .catch((error) => { if (active) setProblem(message(error)); });
    return () => { active = false; };
  }, [source.id, source.revision]);
  const expired = source.credentialExpiresAt && Date.parse(source.credentialExpiresAt) <= Date.now();
  const reauthorize = expired || source.credentialError === "reauthorization_required";
  const type = source.credentialType === "service_account" ? "service_account" : source.credentialType === "oauth" ? "oauth_connected" : "credential_imported";
  return <div className="page-stack">
    <State value={reauthorize ? "reauthorization_required" : source.managedCredential ? type : source.credentialEnv ? "environment_variable" : "no_credential"}/>
    {source.credentialExpiresAt && <small>Token expires {new Date(source.credentialExpiresAt).toLocaleString()}</small>}
    {source.credentialError === "token_endpoint_unavailable" && <small>Token refresh failed. Minato will retry.</small>}
    {problem && <Notice tone="error" clear={() => setProblem("")}>{problem}</Notice>}
    {accounts.some((account) => account.provider === source.kind) && <Fields key={source.accountId}
      label="Link account" alert={setProblem} submit={async (form) => {
        await api(`/sources/${source.id}/subscription-account`, "PUT", { accountId: value(form, "account") });
        await refresh(); alert("Account linked. Route updates queued.");
      }}>
      <Select label="Subscription account" name="account" defaultValue={source.accountId ?? undefined} required
        options={accounts.filter((account) => account.provider === source.kind).map((account) => ({
          value: account.id, label: account.filename ?? account.label,
        }))}/>
    </Fields>}
    {(source.kind === "codex" || source.kind === "openai" || browserSubscription(source.kind)) && <>
      <BrowserOAuth sourceId={source.id} disabled={source.kind !== "codex" && !source.oauthAvailable} refresh={refresh} alert={alert}/>
      {source.kind !== "codex" && !source.oauthAvailable && <small className="field-hint">Configure this provider's OAuth client to enable browser sign-in.</small>}
    </>}
    {(source.kind === "codex" || source.kind === "kimi") && <CodexLogin sourceId={source.id} provider={source.kind} refresh={refresh} alert={alert}/>}
    <Fields label={source.managedCredential ? "Replace credential" : "Import credential"} alert={setProblem} submit={async (form) => {
      const file = form.get("credential");
      if (!(file instanceof File) || !file.size || file.size > 16_384) throw new Error("Choose a JSON file up to 16 KiB");
      let credential: unknown;
      try { credential = JSON.parse(await file.text()); }
      catch { throw new Error("Choose a valid JSON file"); }
      if (!credential || typeof credential !== "object" || Array.isArray(credential)) throw new Error("Choose a JSON object");
      const modelId = value(form, "model").trim();
      await api(`/sources/${source.id}/credential`, "PUT", { ...credential, modelId: modelId || undefined, filename: file.name });
      setFileRevision((revision) => revision + 1);
      setProblem("");
      await refresh();
      alert(source.directoryEnabled === false ? "Credential verified and saved." : "Credential verified. Model sync queued.");
    }}>
      <FileField key={fileRevision} label={source.kind === "vertex" ? "Service account file" : "Credential file"}
        name="credential" accept=".json,application/json" required
        hint={source.kind === "vertex" ? "Use a Google Cloud service account JSON file."
        : source.kind === "codex" ? "Use a Codex CLI or CPA Codex authentication JSON file."
        : subscriptionRelay(source.kind) ? "Use this provider's OAuth authentication JSON file."
        : "Use a JSON object with an apiKey or api_key field."}/>
      <Field label="Model ID for a test request" hint={source.directoryEnabled !== false ? "Leave blank to validate against the directory." : undefined}>
        {(props) => <Input {...props} name="model" value={model} onChange={(event) => setModel(event.target.value)}
          required={source.directoryEnabled === false && !subscriptionRelay(source.kind)} maxLength={256}/>}
      </Field>
    </Fields>
    {source.managedCredential && <div><Button variant="secondary" onClick={() => setRemove(true)}>Remove imported credential</Button></div>}
    {remove && <Drawer kind="confirmation" title="Remove imported credential" close={() => { if (!busy) setRemove(false); }}>
      <p>{source.credentialEnv ? "Minato will validate the configured environment credential and switch when routes are published."
        : "This disables the source. Features using it will switch to another eligible model or become unavailable."}</p>
      {source.credentialEnv && source.directoryEnabled === false && <Field label="Model ID for a test request">
        {(props) => <Input {...props} value={model} onChange={(event) => setModel(event.target.value)} maxLength={256}/>}
      </Field>}
      <div className="actions confirmation-actions">
        <Button variant="secondary" disabled={busy} onClick={() => setRemove(false)}>Cancel</Button>
        <Button variant="danger" disabled={busy || Boolean(source.credentialEnv && source.directoryEnabled === false && !model.trim())}
          onClick={async () => {
            setBusy(true); setProblem("");
            try {
              await api(`/sources/${source.id}/credential`, "DELETE", { disable: !source.credentialEnv, modelId: model.trim() || undefined });
              await refresh();
              alert(source.credentialEnv ? "Environment credential verified. Route updates queued." : "Credential removed. Source disabled.");
            } catch (error) { setProblem(error instanceof Error ? error.message : String(error)); }
            finally { setBusy(false); setRemove(false); }
          }}>Remove credential</Button>
      </div>
    </Drawer>}
  </div>;
}
