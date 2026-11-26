import { useEffect, useState } from "react";
import { api, message } from "./api";
import { Button, Empty, Panel, State, Table } from "./components";

const errors: Record<string, string> = {
  catalog_authentication: "The directory rejected the credential",
  catalog_not_found: "The directory URL was not found",
  catalog_rate_limited: "The directory rate limit was reached",
  catalog_timeout: "The directory request timed out",
  catalog_unreachable: "The directory could not be reached",
  catalog_invalid_response: "The directory returned an invalid model list",
  catalog_pagination_incomplete: "The directory returned incomplete pagination",
  upstream_credential_missing: "Configure a source credential",
  upstream_credential_unreadable: "The imported credential could not be decrypted",
  upstream_credential_origin_mismatch: "Re-import the credential for this directory origin",
  upstream_credential_expired: "The source credential has expired",
};

type Diagnostics = {
  directoryEnabled: boolean;
  sync: { status: string; errorCode: string | null; httpStatus: number | null; recordedAt: string; modelCount: number | null } | null;
  affected: { alias: string; firstModel: string; models: string[] }[];
  affectedTruncated: boolean;
};

export function SourceDiagnostics({ sourceId }: { sourceId: string }) {
  const [data, setData] = useState<Diagnostics>();
  const [problem, setProblem] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let current = true;
    setProblem("");
    void api<Diagnostics>(`/sources/${sourceId}/diagnostics`).then((loaded) => { if (current) setData(loaded); })
      .catch((error) => { if (current) setProblem(message(error)); });
    return () => { current = false; };
  }, [sourceId, revision]);
  const sync = data?.sync;
  return <div className="page-stack">
    <Panel title="Directory sync" action={<Button variant="secondary" onClick={() => setRevision((value) => value + 1)}>Refresh diagnostics</Button>}>
      {problem ? <Empty state="error">{problem}</Empty> : !data ? <Empty state="loading">Loading diagnostics…</Empty>
        : <>{!data.directoryEnabled && <p>Directory sync is disabled.</p>}
          {sync ? <><State value={sync.status}/>
            <p>{sync.errorCode ? errors[sync.errorCode] ?? "Directory sync failed" : `${sync.modelCount ?? 0} models returned`}
              {sync.httpStatus !== null && ` (HTTP ${sync.httpStatus})`}</p>
            <small>{new Date(sync.recordedAt).toLocaleString()}</small>
          </> : <Empty>No sync attempts yet.</Empty>}</>}
    </Panel>
    {data && <Panel title="Features using this source">
      {data.affected.length ? <Table label="Features using this source">
        <thead><tr><th>Feature</th><th>First model</th><th>Models from this source</th></tr></thead>
        <tbody>{data.affected.map((entry) => <tr key={entry.alias}>
          <td>{entry.alias}</td><td>{entry.firstModel}</td><td>{entry.models.join(", ")}</td>
        </tr>)}</tbody>
      </Table> : <Empty>No active feature routes use this source.</Empty>}
      {data.affectedTruncated && <small>Showing the first 200 features.</small>}
    </Panel>}
  </div>;
}
