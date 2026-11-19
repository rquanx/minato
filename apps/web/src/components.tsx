import { useState, type ReactNode } from "react";
import { ArrowRight, Check, Clipboard, X } from "lucide-react";
import { message } from "./api";

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}
export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}
export function Notice({ children, clear }: { children: ReactNode; clear?: () => void }) {
  return <div role="status" className="notice">{children}{clear && <button className="icon" aria-label="Dismiss" onClick={clear}><X size={16}/></button>}</div>;
}
export function Copy({ text, children = "Copy" }: { text: string; children?: ReactNode }) {
  const [status, setStatus] = useState("");
  return <button type="button" className="button secondary" disabled={!text}
    onClick={() => navigator.clipboard.writeText(text).then(() => setStatus("Copied")).catch(() => setStatus("Copy failed"))}>
    {status === "Copied" ? <Check size={15}/> : <Clipboard size={15}/>} {status || children}
  </button>;
}
export function State({ value }: { value: string }) {
  return <span className="state" data-state={value}><i/>{value.replaceAll("_", " ")}</span>;
}
export function Fields({ children, submit, label, alert }: {
  children: ReactNode; submit: (data: FormData) => Promise<void>; label: string; alert: (text: string) => void;
}) {
  const [pending, setPending] = useState(false);
  return <form className="fields" onSubmit={async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true);
    try { await submit(new FormData(form)); }
    catch (error) { alert(message(error)); }
    finally { setPending(false); }
  }}>{children}<button className="button" disabled={pending}>{pending ? "Working…" : label}<ArrowRight size={16}/></button></form>;
}
export const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
