import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, Bell, ChevronRight, FileKey, FlaskConical, LayoutDashboard, Layers3, LogOut, Network, ScrollText, Waypoints } from "lucide-react";
import { api, memberSession, message, session, type Environment, type Feature, type Project, type Source } from "./api";
import { Button, Empty, Field, Input, Select, Fields, Notice, value } from "./components";
import { Projects } from "./projects";
import { Sources } from "./sources";
import { Calls, type Replay } from "./calls";
import { ReplayEditor } from "./replay";
import { Dashboard } from "./dashboard";
import { Usage } from "./usage";
import { Notifications } from "./notifications";
import { AuthenticationFiles } from "./authentication-files";
import "./style.css";

const pages = {
  projects: { label: "Projects", icon: Layers3 },
  sources: { label: "Model sources", icon: Network },
  "authentication-files": { label: "Authentication files", icon: FileKey },
  usage: { label: "Usage", icon: Activity },
  calls: { label: "Calls", icon: ScrollText },
  tests: { label: "Tests", icon: FlaskConical },
  notifications: { label: "Notifications", icon: Bell },
  dashboard: { label: "LiteLLM Dashboard", icon: LayoutDashboard },
};
type Page = keyof typeof pages;
const adminPages: readonly Page[] = ["projects", "sources", "authentication-files", "notifications", "dashboard"];

function selectedPage(): Page {
  const page = new URLSearchParams(window.location.search).get("view") as Page;
  return page && Object.hasOwn(pages, page) ? page : "projects";
}
function Logo() {
  return <div className="wordmark"><span><Waypoints aria-hidden="true" size={20}/></span>Minato</div>;
}

function App() {
  const [signedIn, setSignedIn] = useState<boolean>();
  const [notice, setNotice] = useState("");
  const [page, setPage] = useState<Page>(selectedPage);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [environmentId, setEnvironmentId] = useState("");
  const [features, setFeatures] = useState<Feature[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [replay, setReplay] = useState<Replay>();
  const refreshVersion = useRef(0);
  const project = projects.find((entry) => entry.id === projectId);
  const environment = environments.find((entry) => entry.id === environmentId);
  function navigate(next: Page) {
    setPage(next);
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.pushState(null, "", url);
  }
  useEffect(() => {
    const back = () => setPage(selectedPage());
    window.addEventListener("popstate", back);
    void session().then((active) => {
      setSignedIn(active);
      if (active && memberSession && adminPages.includes(selectedPage())) navigate("usage");
    }).catch((error) => { setNotice(message(error)); setSignedIn(false); });
    return () => window.removeEventListener("popstate", back);
  }, []);
  async function refresh() {
    const revision = ++refreshVersion.current;
    const [records, catalog] = await Promise.all([api<Project[]>("/projects"),
      memberSession ? Promise.resolve([]) : api<Source[]>("/sources")]);
    if (revision !== refreshVersion.current) return;
    setProjects(records); setSources(catalog);
    const activeProject = records.find((entry) => entry.id === projectId) ?? records[0];
    setProjectId(activeProject?.id ?? "");
    if (!activeProject) return;
    const envs = await api<Environment[]>(`/projects/${activeProject.slug}/environments`);
    if (revision !== refreshVersion.current) return;
    setEnvironments(envs);
    const activeEnv = envs.find((entry) => entry.id === environmentId) ?? envs[0];
    setEnvironmentId(activeEnv?.id ?? "");
    const available = activeEnv ? await api<Feature[]>(`/environments/${activeEnv.id}/features`) : [];
    if (revision === refreshVersion.current) setFeatures(available);
  }
  useEffect(() => { if (signedIn) void refresh().catch((error) => setNotice(message(error))); }, [signedIn, projectId, environmentId]);
  if (!signedIn) return <main className="login">
    <section className="login-form" aria-labelledby="sign-in-heading">
      <Logo/>
      <h1 id="sign-in-heading">Sign in</h1>
      {notice && <Notice tone="error">{notice}</Notice>}
      {signedIn === undefined && <Empty state="loading">Checking session…</Empty>}
      {signedIn === false && <Fields label="Open console" alert={setNotice} submit={async (form) => {
        await api("/session", "POST", { password: String(form.get("password") ?? ""), username: value(form, "username") || undefined });
        setSignedIn(await session()); setNotice("");
        if (memberSession) navigate("usage");
      }}><Field label="Username" hint="Leave blank to sign in as administrator.">{(props) =>
        <Input {...props} name="username" autoComplete="username"/>}</Field>
        <Field label="Password">{(props) => <Input {...props} name="password" type="password" required autoComplete="current-password"/>}</Field></Fields>}
    </section>
  </main>;
  return <div className="shell">
    <aside className="sidebar">
      <Logo/>
      <nav aria-label="Console navigation">{(Object.keys(pages) as Page[]).filter((id) =>
        !memberSession || !adminPages.includes(id)).map((id) => {
        const Icon = pages[id].icon;
        return <Button variant="navigation" title={pages[id].label} key={id} aria-current={page === id ? "page" : undefined}
          onClick={() => { setNotice(""); navigate(id); }}><Icon size={16} aria-hidden="true"/><span>{pages[id].label}</span></Button>;
      })}</nav>
      <Button variant="navigation" className="signout" title="Sign out" onClick={async () => {
        try { await api("/session", "DELETE"); setSignedIn(false); }
        catch (error) { setNotice(message(error)); }
      }}><LogOut size={16} aria-hidden="true"/><span>Sign out</span></Button>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>Workspace</span><ChevronRight aria-hidden="true" size={14}/><h1>{pages[page].label}</h1></div>
        {page !== "dashboard" && page !== "sources" && page !== "authentication-files" && <div className="scope">
          <Select label="Project" placeholder="Project" value={projectId} disabled={!projects.length}
            options={projects.map((entry) => ({ value: entry.id, label: entry.displayName }))} onValueChange={(id) => {
            if (id === projectId) return;
            refreshVersion.current++;
            setProjectId(id); setEnvironmentId(""); setReplay(undefined);
            setEnvironments([]); setFeatures([]);
          }}/>
          <Select label="Environment" placeholder="Environment" value={environmentId} disabled={!environments.length}
            options={environments.map((entry) => ({ value: entry.id, label: entry.displayName }))} onValueChange={(id) => {
            if (id === environmentId) return;
            refreshVersion.current++; setEnvironmentId(id); setFeatures([]); setReplay(undefined);
          }}/>
        </div>}
      </header>
      <div className="content">
        {notice && <Notice clear={() => setNotice("")}>{notice}</Notice>}
        {page === "projects" && !memberSession && <Projects key={environmentId} project={project} environment={environment} features={features} sources={sources} refresh={refresh} alert={setNotice}/>}
        {page === "sources" && !memberSession && <Sources records={sources} refresh={refresh} alert={setNotice}/>}
        {page === "authentication-files" && !memberSession && <AuthenticationFiles sources={sources} refresh={refresh} alert={setNotice}/>}
        {page === "dashboard" && !memberSession && <Dashboard alert={setNotice}/>}
        {page === "notifications" && !memberSession && <Notifications project={project} environment={environment}/>}
        {page === "usage" && <Usage key={environmentId || projectId} project={project} environment={environment} features={features} alert={setNotice}/>}
        {page === "calls" && <Calls key={environmentId} environment={environment} features={features} alert={setNotice}
          replay={(record) => { setReplay(record); navigate("tests"); }}/>}
        {page === "tests" && <ReplayEditor key={replay?.replayOf ?? environmentId} environment={environment}
          features={features} sources={sources} input={replay} clear={() => setReplay(undefined)} alert={setNotice}/>}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
