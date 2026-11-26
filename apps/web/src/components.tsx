import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentPropsWithRef, type ComponentPropsWithoutRef, type MouseEvent, type ReactNode } from "react";
import * as RadixSelect from "@radix-ui/react-select";
import { AlertCircle, ArrowRight, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Clipboard, Inbox, LoaderCircle, Upload, X } from "lucide-react";
import { message } from "./api";

export function Button({ variant = "primary", type = "button", className = "", ...props }:
  ComponentPropsWithoutRef<"button"> & { variant?: "primary" | "secondary" | "icon" | "text" | "navigation" | "danger" }) {
  const style = { primary: "button", secondary: "button secondary", icon: "icon", text: "text-button",
    navigation: "nav-button", danger: "button danger" };
  return <button type={type} className={`${style[variant]} ${className}`.trim()} {...props}/>;
}

export function ButtonLink(props: ComponentPropsWithoutRef<"a">) { return <a className="button secondary button-link" {...props}/>; }
export function Input({ className = "", ...props }: ComponentPropsWithoutRef<"input">) {
  return <input className={`control-input ${className}`.trim()} {...props}/>;
}
export function Textarea({ className = "", ...props }: ComponentPropsWithoutRef<"textarea">) {
  return <textarea className={`control-input ${className}`.trim()} {...props}/>;
}
export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string;
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: true }) => ReactNode }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>
    {children({ id, "aria-describedby": error || hint ? `${id}-description` : undefined, "aria-invalid": error ? true : undefined })}
    {(error || hint) && <span id={`${id}-description`} className={error ? "field-error" : "field-hint"}>{error || hint}</span>}
  </div>;
}

export function FileField({ label, hint, onChange, ...props }: Omit<ComponentPropsWithRef<"input">, "type"> & {
  label: string; hint?: string;
}) {
  const [filename, setFilename] = useState("");
  return <Field label={label} hint={hint}>{(field) => <span className="file-control">
    <input {...props} {...field} type="file" onChange={(event) => {
      setFilename(event.currentTarget.files?.[0]?.name ?? "");
      onChange?.(event);
    }}/>
    <span className="button secondary file-trigger" aria-hidden="true"><Upload size={16}/> Choose file</span>
    <span className="file-name" title={filename}>{filename || "No file selected"}</span>
  </span>}</Field>;
}

export function Disclosure({ label, children, className = "", ...props }: ComponentPropsWithoutRef<"details"> & { label: string }) {
  return <details {...props} className={`disclosure ${className}`.trim()}>
    <summary><ChevronRight size={16} aria-hidden="true"/>{label}</summary>
    {children}
  </details>;
}

export function Toggle({ label, kind = "checkbox", ...props }:
  Omit<ComponentPropsWithoutRef<"input">, "type" | "role"> & { label: string; kind?: "checkbox" | "switch" }) {
  return <label className="toggle" data-kind={kind}>
    <Input {...props} type="checkbox" role={kind === "switch" ? "switch" : undefined}/>
    <span className="toggle-mark" aria-hidden="true">{kind === "checkbox" && <Check size={13}/>}</span>
    <span>{label}</span>
  </label>;
}

const OverlayContainer = createContext<HTMLDialogElement | null>(null);
type SelectOption = { value: string; label: string; disabled?: boolean };

export function Select({ label, placeholder = "Select an option", options, value, defaultValue, onValueChange, compact = false, name, ...props }: {
  label: string; placeholder?: string; options: SelectOption[];
  value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
  name?: string; disabled?: boolean; required?: boolean; compact?: boolean;
}) {
  const container = useContext(OverlayContainer);
  const labelId = useId();
  const [selection, setSelection] = useState(defaultValue);
  // Radix reserves an empty value for placeholders. Keep a distinct key for selectable "All" options.
  const emptyOption = options.some((option) => option.value === "");
  let emptyKey = "__minato_empty__";
  while (options.some((option) => option.value === emptyKey)) emptyKey += "_";
  const encode = (entry?: string) => emptyOption && entry === "" ? emptyKey : entry;
  return <div className="select-field"><span className={compact ? "sr-only" : "field-label"} id={labelId}>{label}</span>
    <RadixSelect.Root {...props} name={emptyOption ? undefined : name} value={encode(value)} defaultValue={encode(defaultValue)}
    onValueChange={(entry) => {
      const decoded = entry === emptyKey ? "" : entry;
      setSelection(decoded);
      onValueChange?.(decoded);
    }}>
    <RadixSelect.Trigger className="select-trigger" aria-labelledby={labelId}>
      <span className="select-label"><RadixSelect.Value placeholder={placeholder}/></span>
      <RadixSelect.Icon asChild><ChevronDown className="select-chevron" size={16} aria-hidden="true"/></RadixSelect.Icon>
    </RadixSelect.Trigger>
    <RadixSelect.Portal container={container}>
      <RadixSelect.Content className="select-menu" position="popper" align="start" sideOffset={4} collisionPadding={8}>
        <RadixSelect.ScrollUpButton className="select-scroll"><ChevronUp size={16} aria-hidden="true"/></RadixSelect.ScrollUpButton>
        <RadixSelect.Viewport className="select-options">
          {options.map((option) => <RadixSelect.Item key={option.value} className="select-option"
            value={encode(option.value)!} disabled={option.disabled}>
            <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
            <RadixSelect.ItemIndicator asChild><Check className="select-check" size={16} aria-hidden="true"/></RadixSelect.ItemIndicator>
          </RadixSelect.Item>)}
        </RadixSelect.Viewport>
        <RadixSelect.ScrollDownButton className="select-scroll"><ChevronDown size={16} aria-hidden="true"/></RadixSelect.ScrollDownButton>
      </RadixSelect.Content>
    </RadixSelect.Portal>
    </RadixSelect.Root>
    {emptyOption && name && <input type="hidden" name={name} value={value ?? selection ?? ""} disabled={props.disabled}/>}
  </div>;
}

export function Sections<T extends string>({ items, active, onChange, label }: {
  items: readonly { id: T; label: string }[]; active: T; onChange: (value: T) => void; label: string;
}) {
  return <nav className="sections" aria-label={label}>{items.map((item) =>
    <Button key={item.id} variant="text" aria-current={item.id === active ? "true" : undefined}
      onClick={() => onChange(item.id)}>{item.label}</Button>)}</nav>;
}

function isBackdrop(event: MouseEvent<HTMLDialogElement>) {
  if (event.target !== event.currentTarget) return false;
  const { left, right, top, bottom } = event.currentTarget.getBoundingClientRect();
  return event.clientX < left || event.clientX >= right || event.clientY < top || event.clientY >= bottom;
}

export function Drawer({ title, close, children, kind = "drawer", busy = false }: {
  title: string; close: () => void; children: ReactNode; kind?: "drawer" | "modal" | "confirmation"; busy?: boolean;
}) {
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  const backdropPress = useRef(false);
  const heading = useId();
  function dismiss() {
    if (!busy && !dialog?.querySelector('[aria-busy="true"]')) close();
  }
  useLayoutEffect(() => {
    if (!dialog) return;
    const trigger = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (trigger instanceof HTMLElement && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
  }, [dialog]);
  return <dialog className={kind} ref={setDialog} aria-labelledby={heading} aria-busy={busy || undefined}
    onPointerDown={(event) => { backdropPress.current = event.isPrimary && event.button === 0 && isBackdrop(event); }}
    onPointerUp={(event) => { backdropPress.current &&= isBackdrop(event); }}
    onPointerCancel={() => { backdropPress.current = false; }}
    onClick={(event) => {
      const clickedBackdrop = backdropPress.current && isBackdrop(event);
      backdropPress.current = false;
      if (clickedBackdrop) dismiss();
    }}
    onCancel={(event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      dismiss();
    }}>
    <header><h2 id={heading}>{title}</h2><Button variant="icon" aria-label="Close" disabled={busy} onClick={dismiss}><X size={16}/></Button></header>
    <OverlayContainer.Provider value={dialog}><div className="drawer-body">{children}</div></OverlayContainer.Provider>
  </dialog>;
}

export function Table({ children, label }: { children: ReactNode; label: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observe = new ResizeObserver(() => setScrollable(element.scrollWidth > element.clientWidth));
    observe.observe(element);
    if (element.firstElementChild) observe.observe(element.firstElementChild);
    return () => observe.disconnect();
  }, []);
  return <div ref={viewport} className="table-scroll" tabIndex={scrollable ? 0 : undefined}
    role={scrollable ? "region" : undefined} aria-label={scrollable ? `${label} scroll area` : undefined}>
    <table aria-label={label}>{children}</table></div>;
}

export function Pagination({ page, status, previous, next, disabled }: {
  page: number; status?: string; previous?: () => void; next?: () => void; disabled?: boolean;
}) {
  return <nav className="pagination" aria-label="Pagination">
    <span aria-live="polite">{status ?? `Page ${page}`}</span>
    <div className="actions">
      <Button variant="secondary" disabled={disabled || !previous} onClick={previous}><ChevronLeft size={15}/> Previous</Button>
      <Button variant="secondary" disabled={disabled || !next} onClick={next}>Next <ChevronRight size={15}/></Button>
    </div>
  </nav>;
}

export function usePage<T>(items: T[], size = 10) {
  const [requested, setPage] = useState(1);
  const total = Math.max(1, Math.ceil(items.length / size));
  const page = Math.min(requested, total);
  const offset = (page - 1) * size;
  return {
    items: items.slice(offset, offset + size), reset: () => setPage(1),
    controls: {
      page, status: items.length ? `${offset + 1}–${Math.min(offset + size, items.length)} of ${items.length}` : "0 records",
      previous: page > 1 ? () => setPage(page - 1) : undefined,
      next: page < total ? () => setPage(page + 1) : undefined,
    },
  };
}

export function Empty({ children, state = "empty", retry }: {
  children: ReactNode; state?: "empty" | "loading" | "error"; retry?: () => void;
}) {
  const Icon = state === "loading" ? LoaderCircle : state === "error" ? AlertCircle : Inbox;
  return <div className="empty" data-state={state} role={state === "error" ? "alert" : state === "loading" ? "status" : undefined}>
    <Icon size={20} aria-hidden="true"/><p>{children}</p>
    {retry && <Button variant="secondary" onClick={retry}>Try again</Button>}
  </div>;
}
export function Panel({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return <section className="panel"><div className="panel-heading"><h2>{title}</h2>{action}</div>{children}</section>;
}
export function Notice({ children, clear, tone = "info" }: { children: ReactNode; clear?: () => void; tone?: "info" | "error" }) {
  return <div role={tone === "error" ? "alert" : "status"} className="notice" data-tone={tone}>
    {tone === "error" && <AlertCircle size={16} aria-hidden="true"/>}<span>{children}</span>
    {clear && <Button variant="icon" aria-label="Dismiss" onClick={clear}><X size={16}/></Button>}</div>;
}
export function Copy({ text, children = "Copy" }: { text: string; children?: ReactNode }) {
  const [feedback, setFeedback] = useState<{ text: string; status: string }>();
  const status = feedback?.text === text ? feedback.status : "";
  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(undefined), 2200);
    return () => window.clearTimeout(timer);
  }, [feedback]);
  return <Button variant="secondary" disabled={!text}
    onClick={async () => {
      try { await navigator.clipboard.writeText(text); setFeedback({ text, status: "Copied" }); }
      catch { setFeedback({ text, status: "Copy failed" }); }
    }}>
    {status === "Copied" ? <Check size={16} aria-hidden="true"/> : <Clipboard size={16} aria-hidden="true"/>}
    <span aria-live="polite">{status || children}</span>
  </Button>;
}
export function State({ value }: { value: string }) {
  return <span className="state" data-state={value}><i/>{value.replaceAll("_", " ")}</span>;
}
export function Fields({ children, submit, label, alert }: {
  children: ReactNode; submit: (data: FormData) => Promise<void>; label: string; alert: (text: string) => void;
}) {
  const [pending, setPending] = useState(false);
  return <form className="fields" aria-busy={pending || undefined} onSubmit={async (event) => {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    setPending(true);
    try { await submit(new FormData(form)); }
    catch (error) { alert(message(error)); }
    finally { setPending(false); }
  }}><fieldset className="fields-body" disabled={pending}>{children}</fieldset>
    <Button type="submit" disabled={pending}>{pending ? "Working…" : label}
      {pending ? <LoaderCircle className="loading-icon" size={16} aria-hidden="true"/> : <ArrowRight size={16} aria-hidden="true"/>}
    </Button></form>;
}
export const value = (form: FormData, key: string) => String(form.get(key) ?? "").trim();
