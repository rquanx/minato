import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Activity, ChevronRight, FlaskConical, Layers3, LogOut, Network, ScrollText, Waypoints } from "lucide-react";
import { api, memberSession, message, session, type Environment, type Feature, type Project, type Source } from "./api";
import { Fields, Notice, value } from "./components";
import { Projects } from "./projects";
import { Sources } from "./sources";
import { Calls, type Replay } from "./calls";
import { ReplayEditor } from "./replay";
import "./style.css";

const pages = {
  projects: { label: "Projects", icon: Layers3 },
  sources: { label: "Model sources", icon: Network },
  usage: { label: "Usage", icon: Activity },
  calls: { label: "Calls", icon: ScrollText },
  tests: { label: "Tests", icon: FlaskConical },
};
type Page = keyof typeof pages;

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
      if (active && memberSession && ["projects", "sources"].includes(selectedPage())) navigate("usage");
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
      {notice && <Notice>{notice}</Notice>}
      {signedIn === false && <Fields label="Open console" alert={setNotice} submit={async (form) => {
        await api("/session", "POST", { password: String(form.get("password") ?? ""), username: value(form, "username") || undefined });
        setSignedIn(await session()); setNotice("");
        if (memberSession) navigate("usage");
      }}><label>Username<input name="username" autoComplete="username" placeholder="Leave blank for administrator"/></label>
        <label>Password<input name="password" type="password" required autoComplete="current-password"/></label></Fields>}
    </section>
  </main>;
  return <div className="shell">
    <aside className="sidebar">
      <Logo/>
      <nav aria-label="Console navigation">{(Object.keys(pages) as Page[]).filter((id) =>
        !memberSession || id !== "projects" && id !== "sources").map((id) => {
        const Icon = pages[id].icon;
        return <button key={id} aria-current={page === id ? "page" : undefined} onClick={() => navigate(id)}><Icon size={19}/><span>{pages[id].label}</span></button>;
      })}</nav>
      <button className="signout" onClick={async () => {
        try { await api("/session", "DELETE"); setSignedIn(false); }
        catch (error) { setNotice(message(error)); }
      }}><LogOut size={17}/><span>Sign out</span></button>
    </aside>
    <main className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>Workspace</span><ChevronRight aria-hidden="true" size={14}/><span>{pages[page].label}</span></div>
        <div className="scope">
          <select aria-label="Project" value={projectId} onChange={(event) => {
            if (event.target.value === projectId) return;
            refreshVersion.current++;
            setProjectId(event.target.value); setEnvironmentId(""); setReplay(undefined);
            setEnvironments([]); setFeatures([]);
          }}><option value="" disabled>Project</option>{projects.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</select>
          <select aria-label="Environment" value={environmentId} onChange={(event) => {
            if (event.target.value === environmentId) return;
            refreshVersion.current++; setEnvironmentId(event.target.value); setFeatures([]); setReplay(undefined);
          }}>
            <option value="" disabled>Environment</option>{environments.map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}</option>)}</select>
        </div>
      </header>
      <div className="content">
        <h1>{pages[page].label}</h1>
        {notice && <Notice clear={() => setNotice("")}>{notice}</Notice>}
        {page === "projects" && !memberSession && <Projects key={environmentId} project={project} environment={environment} features={features} sources={sources} refresh={refresh} alert={setNotice}/>}
        {page === "sources" && !memberSession && <Sources records={sources} refresh={refresh} alert={setNotice}/>}
        {(page === "calls" || page === "usage") && <Calls key={environmentId} environment={environment} features={features} view={page} alert={setNotice}
          replay={(record) => { setReplay(record); navigate("tests"); }}/>}
        {page === "tests" && <ReplayEditor key={replay?.replayOf ?? environmentId} environment={environment}
          features={features} sources={sources} input={replay} clear={() => setReplay(undefined)} alert={setNotice}/>}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById("root")!).render(<App/>);
