// classmcp landing page. Plain JS, no build step.
(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        return v === null ? fallback : JSON.parse(v);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {}
    },
  };

  // ---- Toast + copy ------------------------------------------------------

  const toast = $("#toast");
  let toastTimer;
  function showToast(text) {
    toast.textContent = text;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 1800);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;opacity:0";
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {}
      area.remove();
      return ok;
    }
  }

  document.addEventListener("click", async (event) => {
    const btn = event.target.closest("[data-copy-target], [data-copy-text]");
    if (!btn) return;
    const text = btn.dataset.copyText ?? $("#" + btn.dataset.copyTarget)?.textContent ?? "";
    const ok = await copyText(text.trim());
    showToast(ok ? btn.dataset.copyLabel || "Copied" : "Copy failed — select the text instead");
    if (ok) {
      btn.classList.add("is-copied");
      setTimeout(() => btn.classList.remove("is-copied"), 1600);
    }
  });

  // ---- Header: theme, menu, scroll state, active nav ------------------------

  const root = document.documentElement;
  $("#theme-toggle").addEventListener("click", () => {
    const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("classmcp-theme", next);
    } catch {}
  });

  const menuBtn = $("#menu-btn");
  const nav = $("#nav");
  const setMenu = (open) => {
    nav.classList.toggle("is-open", open);
    menuBtn.setAttribute("aria-expanded", String(open));
    menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  };
  menuBtn.addEventListener("click", () => setMenu(!nav.classList.contains("is-open")));
  nav.addEventListener("click", (e) => e.target.closest("a") && setMenu(false));
  document.addEventListener("keydown", (e) => e.key === "Escape" && setMenu(false));

  const header = $("#header");
  const onScroll = () => header.classList.toggle("is-scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  if ("IntersectionObserver" in window) {
    const links = new Map($$(".nav a").map((a) => [a.getAttribute("href").slice(1), a]));
    const spy = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          links.forEach((a) => a.classList.remove("is-active"));
          links.get(entry.target.id)?.classList.add("is-active");
        }
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    links.forEach((_, id) => {
      const el = document.getElementById(id);
      if (el) spy.observe(el);
    });

  }

  // ---- Demo: three real sessions, replayed ---------------------------------

  const ext = (name) => {
    const e = name.split(".").pop().toLowerCase();
    return `<span class="ext ${e}">${esc(e)}</span>`;
  };

  const SCENARIOS = {
    due: {
      ask: "do i have any assignments due?",
      trace: [
        ["get_overview", '{ view: "due" }', "1 due"],
        ["get_overview", '{ view: "missing" }', "8 missing"],
      ],
      answer: `
        <p>Yes, one assignment is due soon:</p>
        <div class="due-card">
          <div class="when">Nov 7<br />in 3 days</div>
          <strong>Semester Project (PBL) - Submission 1 (Proposal)</strong>
          <span>Applications of ICT (GE-100) (Sec-B), 10 points, not started</span>
        </div>
        <p>You also have <strong>8 overdue assignments</strong> that show as not turned in:</p>
        <table class="late">
          <thead><tr><th>Due</th><th>Course</th><th>Assignment</th><th>Pts</th></tr></thead>
          <tbody>
            <tr><td>Nov 2</td><td>Technical and Business Writing</td><td>Generating Ideas</td><td>10</td></tr>
            <tr><td>Oct 23</td><td>Analysis of algos</td><td>assignment#3</td><td>10</td></tr>
            <tr><td>Oct 21</td><td>ANN &amp; DL (CS-380) (Sec-B)</td><td>Assignment # 02</td><td>15</td></tr>
            <tr><td>Oct 20</td><td>PDC</td><td>PDC Week 5 Lab Task</td><td>100</td></tr>
            <tr><td>Oct 17</td><td>PDC</td><td>PDC Assignment 1</td><td>100</td></tr>
            <tr><td>Oct 16</td><td>ANN &amp; DL (CS-380) (Sec-B)</td><td>Assignment # 01</td><td>15</td></tr>
          </tbody>
        </table>
`,
    },
    download: {
      ask: "download all analysis algo lecture and move them here",
      trace: [
        ["search", '{ query: "lectures", course: "Analysis of algos", kinds: ["material"] }', "1 material: Lectures"],
        [
          "download_files",
          '{ course: "Analysis of algos", material: "Lectures", destinationDir: "…/Downloads/analysis-of-algos-lectures" }',
          "7 saved",
        ],
        ["shell", "mv ~/Downloads/analysis-of-algos-lectures/* .", "7 moved", true],
      ],
      answer: () => {
        const files = [
          "Algo1-2-BS-basics.pptx",
          "Algo3-4-BS-sorting1.pdf",
          "Algo5-6-BS-sorting2.pdf",
          "Algo7-8-BS-HeapSort.pdf",
          "Algo9-10-BS-recurrence.pdf",
          "Master's theorem.pdf",
          "ml_complexity_full.pptx",
        ];
        return `
          <p>All <strong>7 files</strong> from the Analysis of algos “Lectures” material are now in your working folder:</p>
          <ul class="files">${files
            .map((f, i) => `<li style="animation-delay:${i * 60}ms">${ext(f)}<span>${esc(f)}</span></li>`)
            .join("")}</ul>
          <p>They went to <code>analysis-of-algos-lectures</code> in Downloads first, then I moved them, so nothing is left behind. <code>ml_complexity_full.pptx</code> was in the same material, so I included it.</p>`;
      },
    },
    summarize: {
      ask: "read Algo9-10-BS-recurrence.pdf and summarize it",
      trace: [["read", "Algo9-10-BS-recurrence.pdf", "18 slides", true]],
      answer: `
        <p>This is the lecture deck <strong>“Design and Analysis of Algorithms: Recurrences”</strong> (18 slides, Algo 9–10).</p>
        <h4>1. What a recurrence is (slides 3–6)</h4>
        <ul>
          <li>A recurrence defines a function in terms of smaller inputs. It has a base case (boundary condition) and is defined over natural numbers.</li>
          <li>Examples: factorial, f(n) = n·f(n−1) with f(0) = 1, and Fibonacci, f(n) = f(n−1) + f(n−2) with f(0) = 0, f(1) = 1.</li>
          <li><strong>Decrease-and-conquer:</strong> T(n) = T(n−c) + f(n)</li>
          <li><strong>Divide-and-conquer:</strong> T(n) = aT(n/b) + f(n) — a subproblems, shrink factor b, f(n) to divide and combine.</li>
        </ul>
        <h4>2. Applications (slide 8)</h4>
        <ul>
          <li>Linear search: T(n) = T(n−1) + c</li>
          <li>Binary search: T(n) = T(n/2) + c</li>
          <li>Finding a maximum: T(n) = 2T(n/2) + c</li>
        </ul>`,
    },
  };

  const demoBody = $("#demo-body");
  const chips = $$(".chip");
  let runId = 0;
  let current = "due";
  const wait = (ms) => new Promise((r) => setTimeout(r, reduceMotion ? 0 : ms));
  const scrollDemo = () => demoBody.scrollTo({ top: demoBody.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });

  async function play(key, customAsk) {
    const id = ++runId;
    const live = () => id === runId;
    const sc = SCENARIOS[key];
    current = key;
    chips.forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.scenario === key)));
    demoBody.innerHTML = "";

    const user = document.createElement("div");
    user.className = "msg-user";
    demoBody.append(user);
    const text = customAsk || sc.ask;
    if (reduceMotion) user.textContent = text;
    else
      for (let i = 1; i <= text.length; i++) {
        if (!live()) return;
        user.textContent = text.slice(0, i);
        await wait(18);
      }
    await wait(300);
    if (!live()) return;

    const trace = document.createElement("div");
    trace.className = "trace";
    trace.setAttribute("role", "log");
    trace.setAttribute("aria-label", "Tool calls");
    demoBody.append(trace);
    for (const [name, args, result, local] of sc.trace) {
      if (!live()) return;
      trace.insertAdjacentHTML(
        "beforeend",
        `<div class="trace-line"><span class="arrow">→</span><span class="name${local ? " local" : ""}">${esc(name)}</span><span class="args">${esc(args)}</span></div>`,
      );
      scrollDemo();
      await wait(650);
      if (!live()) return;
      trace.insertAdjacentHTML(
        "beforeend",
        `<div class="trace-line"><span class="arrow">←</span><span class="res">${esc(result)}</span></div>`,
      );
      scrollDemo();
      await wait(250);
    }

    const typing = document.createElement("div");
    typing.className = "typing";
    typing.innerHTML = "<i></i><i></i><i></i>";
    demoBody.append(typing);
    scrollDemo();
    await wait(700);
    if (!live()) return;
    typing.remove();

    const answer = document.createElement("div");
    answer.className = "answer";
    answer.innerHTML = typeof sc.answer === "function" ? sc.answer() : sc.answer;
    demoBody.append(answer);
    demoBody.scrollTo({ top: Math.max(0, answer.offsetTop - 120), behavior: reduceMotion ? "auto" : "smooth" });
  }

  chips.forEach((chip) => chip.addEventListener("click", () => play(chip.dataset.scenario)));
  $("#demo-replay").addEventListener("click", () => play(current));

  $("#demo-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const input = $("#demo-q");
    const q = input.value.trim();
    if (!q) return;
    input.value = "";
    const lower = q.toLowerCase();
    let key = null;
    if (/(due|assign|late|missing|overdue|homework|week|deadline)/.test(lower)) key = "due";
    else if (/(download|lecture|handout|slides|files?|material)/.test(lower)) key = "download";
    else if (/(summar|read|pdf|recurrence|explain|deck)/.test(lower)) key = "summarize";
    if (key) return play(key, q);
    runId++;
    chips.forEach((c) => c.setAttribute("aria-pressed", "false"));
    demoBody.innerHTML = `<div class="msg-user">${esc(q)}</div>
      <div class="answer"><p>This replay has three recorded sessions. Install classmcp and your agent can answer this from your own Classroom.</p>
      <p><a href="#setup">Set it up</a></p></div>`;
  });

  // Start when the demo scrolls into view (it's above the fold on desktop).
  if ("IntersectionObserver" in window) {
    const once = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        once.disconnect();
        play("due");
      }
    });
    once.observe(demoBody);
  } else play("due");

  // ---- Syntax-light code rendering ------------------------------------------

  function highlight(code) {
    return code
      .split(/("(?:[^"\\\n]|\\.)*"|#[^\n]*|\/\/[^\n]*)/g)
      .map((part) => {
        if (!part) return "";
        if (part.startsWith('"')) return `<span class="s">${esc(part)}</span>`;
        if (part.startsWith("#") || part.startsWith("//")) return `<span class="c">${esc(part)}</span>`;
        return esc(part);
      })
      .join("");
  }

  let codeId = 0;
  // variants: [{ label, code }]. One variant → plain label; several → tabs.
  function codeBlock(variants) {
    const id = `cb${++codeId}`;
    const bar =
      variants.length > 1
        ? `<div class="code-tabs" role="tablist">${variants
            .map(
              (v, i) =>
                `<button type="button" role="tab" aria-selected="${i === 0}" data-variant="${i}">${esc(v.label)}</button>`,
            )
            .join("")}</div>`
        : `<span class="label">${variants[0].label ? esc(variants[0].label) : ""}</span>`;
    return `<div class="code-bar">${bar}
        <button class="copy" type="button" data-copy-target="${id}" aria-label="Copy code">
          <svg class="icon i-copy" aria-hidden="true"><use href="#i-copy" /></svg>
          <svg class="icon i-done" aria-hidden="true"><use href="#i-check" /></svg>
        </button></div>
      <pre tabindex="0"><code id="${id}">${highlight(variants[0].code)}</code></pre>`;
  }
  function wireCodeTabs(container, variants) {
    $$(".code-tabs button", container).forEach((btn) =>
      btn.addEventListener("click", () => {
        $$(".code-tabs button", container).forEach((b) => b.setAttribute("aria-selected", String(b === btn)));
        $("code", container).innerHTML = highlight(variants[Number(btn.dataset.variant)].code);
      }),
    );
  }

  // ---- Tools explorer --------------------------------------------------------

  const TOOLS = {
    get_overview: {
      about:
        "List due, missing, new, or graded work across your courses, or list the courses themselves.",
      params: [
        ["view", '"due" (default), "missing", "new", "grades", or "courses"'],
        ["window", "Days ahead for due, days back for new. 1–30, default 7."],
        ["limit", "Max rows. 1–50, default 20."],
        ["query", "Case-insensitive filter on title or course name."],
        ["includeArchived", "Also scan archived courses. Default false."],
        ["detail", '"concise" (default) or "detailed" (adds links and work type).'],
      ],
      example: `{ "view": "missing" }`,
    },
    get_assignment: {
      about: "One assignment in full: the prompt, your state and grade, teacher attachments, your attachments, rubric, and recent submission history.",
      params: [
        ["course / courseId", "Course name (fuzzy) or exact id."],
        ["assignment / assignmentId", "Assignment title (fuzzy) or exact id."],
        ["maxDescChars", "Prompt length. 0–2000, default 400."],
      ],
      example: `{ "course": "Applications of ICT", "assignment": "Semester Project" }`,
    },
    search: {
      about: "Keyword search over assignment, material, and announcement titles and text, across every course. All words must match.",
      params: [
        ["query", "Required. Up to 120 characters."],
        ["course / courseId", "Optional: limit to one course."],
        ["kinds", '["assignment", "material", "announcement"] — any subset.'],
        ["limit", "Max hits. 1–30, default 10."],
        ["includeArchived", "Also scan archived courses."],
      ],
      example: `{ "query": "lectures", "course": "Analysis of algos", "kinds": ["material"] }`,
    },
    download_files: {
      about:
        "Save an item’s attachments, or specific Drive files, to your machine. Google Docs, Sheets, and Slides are exported. Never overwrites: collisions become name (1).ext.",
      params: [
        ["course + assignment / material / announcement", "Download every attachment of that item."],
        ["fileIds", "Or up to 20 specific Drive file ids."],
        ["destinationDir", "Must be inside ~/Downloads or CLASSMCP_WORKDIR. Default <root>/classmcp."],
        ["exportAs", '"pdf", "docx", "xlsx", or "pptx" for Google Docs, Sheets, and Slides.'],
      ],
      example: `{ "course": "Analysis of algos", "material": "Lectures", "exportAs": "pdf" }`,
    },
    submit_work: {
      about:
        "Upload local files to Drive, then try to attach them and optionally turn in.",
      params: [
        ["course + assignment", "Name or id of each."],
        ["files", "Up to 10 local files, 100 MB each, inside allowed folders."],
        ["fileIds / link", "Up to 10 Drive ids, and one http(s) link."],
        ["turnIn", "Default false. true also attempts turn-in…"],
        ["confirmTurnIn", 'Must be exactly "I confirm turn in" when turnIn is true.'],
      ],
      example: `{ "course": "PDC", "assignment": "Week 5 Lab Task",
  "files": [{ "path": "/home/you/Downloads/lab5.pdf" }] }`,
      note: "Expect <code>blocked: true</code> on teacher-created coursework (Google returns 403 @ProjectPermissionDenied). Your file is still in Drive; open the returned Classroom link to attach and turn in.",
    },
  };

  const toolPanel = $("#tool-panel");
  const toolTabs = $$("#tool-list [role=tab]");
  function showTool(name, focus) {
    const t = TOOLS[name];
    toolTabs.forEach((tab) => {
      const on = tab.dataset.tool === name;
      tab.setAttribute("aria-selected", String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    toolPanel.setAttribute("aria-labelledby", `tt-${name}`);
    toolPanel.innerHTML = `
      <h3><code>${name}</code></h3>
      <p>${esc(t.about)}</p>
      <table class="params"><thead><tr><th>Input</th><th>What it does</th></tr></thead><tbody>
        ${t.params.map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`).join("")}
      </tbody></table>
      <div class="code">${codeBlock([{ label: "", code: t.example }])}</div>
      ${t.note ? `<p class="note">${t.note}</p>` : ""}`;
  }
  toolTabs.forEach((tab, i) => {
    tab.addEventListener("click", () => showTool(tab.dataset.tool));
    tab.addEventListener("keydown", (e) => {
      const keys = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const next = toolTabs[(i + keys[e.key] + toolTabs.length) % toolTabs.length];
      showTool(next.dataset.tool, true);
    });
  });
  showTool("get_overview");

  // ---- Setup builder ----------------------------------------------------------

  const HOSTS = {
    codex: { name: "Codex" },
    opencode: { name: "OpenCode" },
    claude: { name: "Claude Code" },
    cursor: { name: "Cursor" },
    other: { name: "your agent" },
  };

  const saved = store.get("classmcp-builder", {});
  const state = {
    host: HOSTS[saved.host] ? saved.host : "codex",
    os: saved.os === "win" ? "win" : "unix",
    launch: saved.launch === "abs" ? "abs" : "global",
    node: typeof saved.node === "string" ? saved.node : "",
    cli: typeof saved.cli === "string" ? saved.cli : "",
    workdir: typeof saved.workdir === "string" ? saved.workdir : "",
  };

  const PLACEHOLDER = {
    unix: { node: "/path/to/node", cli: "/path/to/gcrclassmcp/dist/cli.js", wd: "/home/you/school" },
    win: {
      node: "C:\\Program Files\\nodejs\\node.exe",
      cli: "C:\\Users\\you\\AppData\\Roaming\\npm\\node_modules\\gcrclassmcp\\dist\\cli.js",
      wd: "C:\\Users\\you\\school",
    },
  };

  function launcher() {
    if (state.launch === "global") return { command: "classmcp", args: ["serve"] };
    const ph = PLACEHOLDER[state.os];
    return { command: state.node.trim() || ph.node, args: [state.cli.trim() || ph.cli, "serve"] };
  }
  const shq = (s) => {
    if (/^[\w@%+=:,./\\-]+$/.test(s)) return s;
    return state.os === "win" ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, "'\\''")}'`;
  };
  const launchLine = () => {
    const l = launcher();
    return [l.command, ...l.args].map(shq).join(" ");
  };
  const home = (p) => (state.os === "win" ? "%USERPROFILE%\\" + p.replace(/\//g, "\\") : "~/" + p);
  const wd = () => state.workdir.trim();
  const json = (v) => JSON.stringify(v, null, 2);
  const tomlStr = (s) => JSON.stringify(s);

  function installBlock() {
    const lines =
      state.os === "win"
        ? ["node --version    # v20 or newer", "npm install -g gcrclassmcp@next", "classmcp --version"]
        : ["node --version    # v20 or newer", "npm install -g gcrclassmcp@next", "classmcp --version"];
    if (state.launch === "abs") {
      lines.push("", "# Absolute paths for your agent config:");
      if (state.os === "win") lines.push("(Get-Command node).Source", 'Join-Path (npm root -g) "gcrclassmcp\\dist\\cli.js"');
      else lines.push("command -v node", 'echo "$(npm root -g)/gcrclassmcp/dist/cli.js"');
    }
    return [{ label: "", code: lines.join("\n") }];
  }

  function authBlock() {
    return [
      {
        label: "",
        code:
          "classmcp setup     # finds client_secret*.json in Downloads, opens Google consent\nclassmcp doctor    # expect: All checks passed.",
      },
    ];
  }

  function registerContent() {
    const l = launcher();
    const w = wd();
    const h = state.host;
    let blocks = [];
    let before = "";

    if (h === "codex") {
      const env = w ? ` --env CLASSMCP_WORKDIR=${shq(w)}` : "";
      const toml = [
        "[mcp_servers.classmcp]",
        `command = ${tomlStr(l.command)}`,
        `args = [${l.args.map(tomlStr).join(", ")}]`,
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 300",
      ];
      if (w) toml.push("", "[mcp_servers.classmcp.env]", `CLASSMCP_WORKDIR = ${tomlStr(w)}`);
      blocks = [
        { label: "codex mcp add", code: `codex mcp add classmcp${env} -- ${launchLine()}` },
        { label: home(".codex/config.toml"), code: toml.join("\n") },
      ];
    } else if (h === "opencode") {
      const entry = { type: "local", command: [l.command, ...l.args], enabled: true, timeout: 60000 };
      if (w) entry.environment = { CLASSMCP_WORKDIR: w };
      blocks = [
        {
          label: home(".config/opencode/opencode.jsonc"),
          code: json({ $schema: "https://opencode.ai/config.json", mcp: { classmcp: entry } }),
        },
      ];
    } else if (h === "claude") {
      const env = w ? ` -e CLASSMCP_WORKDIR=${shq(w)}` : "";
      const entry = { type: "stdio", command: l.command, args: l.args };
      if (w) entry.env = { CLASSMCP_WORKDIR: w };
      blocks = [
        { label: "claude mcp add", code: `claude mcp add --scope user${env} classmcp -- ${launchLine()}` },
        { label: home(".claude.json"), code: json({ mcpServers: { classmcp: entry } }) },
      ];
    } else if (h === "cursor") {
      const entry = { command: l.command, args: l.args };
      if (w) entry.env = { CLASSMCP_WORKDIR: w };
      blocks = [{ label: home(".cursor/mcp.json"), code: json({ mcpServers: { classmcp: entry } }) }];
    } else {
      before = `<p>Find your agent’s MCP config in its own docs, then add a local stdio server:</p>`;
      const entry = { command: l.command, args: l.args };
      if (w) entry.env = { CLASSMCP_WORKDIR: w };
      blocks = [{ label: "mcpServers", code: json({ mcpServers: { classmcp: entry } }) }];
    }
    return { before, blocks };
  }

  const VERIFY = {
    codex: { title: "Restart Codex and ask", code: "codex mcp list    # classmcp listed" },
    opencode: { title: "Restart OpenCode and ask", code: "opencode mcp list    # classmcp connected" },
    claude: { title: "Restart Claude Code and ask", code: "claude mcp list    # classmcp connected" },
    cursor: { title: "Reload Cursor and ask", code: null },
    other: { title: "Restart your agent and ask", code: null },
  };

  function renderBuilder() {
    $("#abs-fields").hidden = state.launch !== "abs";
    const ph = PLACEHOLDER[state.os];
    $("#in-node").placeholder = ph.node;
    $("#in-cli").placeholder = ph.cli;
    $("#in-workdir").placeholder = ph.wd;

    $('[data-block="install"]').innerHTML = codeBlock(installBlock());
    $('[data-block="auth"]').innerHTML = codeBlock(authBlock());

    $("#register-title").textContent = `Register with ${state.host === "other" ? "your agent" : HOSTS[state.host].name}`;
    const reg = registerContent();
    const body = $("#register-body");
    body.innerHTML = `${reg.before}<div class="code"></div>`;
    const cb = $(".code", body);
    cb.innerHTML = codeBlock(reg.blocks);
    wireCodeTabs(cb, reg.blocks);

    const v = VERIFY[state.host];
    $("#verify-title").textContent = v.title;
    const vb = $('[data-block="verify"]');
    vb.hidden = !v.code;
    vb.innerHTML = v.code ? codeBlock([{ label: "", code: v.code }]) : "";
    store.set("classmcp-builder", state);
  }

  // Sync controls with saved state.
  $$('input[name="host"]').forEach((r) => (r.checked = r.value === state.host));
  $$('input[name="os"]').forEach((r) => (r.checked = r.value === state.os));
  $$('input[name="launch"]').forEach((r) => (r.checked = r.value === state.launch));
  $("#in-node").value = state.node;
  $("#in-cli").value = state.cli;
  $("#in-workdir").value = state.workdir;

  $(".controls").addEventListener("change", (e) => {
    const t = e.target;
    if (t.name in state && t.type === "radio") {
      state[t.name] = t.value;
      renderBuilder();
    }
  });
  const inputs = { "in-node": "node", "in-cli": "cli", "in-workdir": "workdir" };
  $(".controls").addEventListener("input", (e) => {
    const key = inputs[e.target.id];
    if (key) {
      state[key] = e.target.value;
      renderBuilder();
    }
  });
  renderBuilder();

  // Progress
  const doneBoxes = $$("[data-done]");
  const done = new Set(store.get("classmcp-steps", []));
  function renderProgress() {
    doneBoxes.forEach((box) => {
      box.checked = done.has(box.dataset.done);
      box.closest(".step").classList.toggle("is-done", box.checked);
    });
    const n = doneBoxes.filter((b) => b.checked).length;
    $("#progress-fill").style.width = `${(n / doneBoxes.length) * 100}%`;
    $("#progress").setAttribute("aria-valuenow", String(n));
    store.set("classmcp-steps", [...done]);
  }
  doneBoxes.forEach((box) =>
    box.addEventListener("change", () => {
      box.checked ? done.add(box.dataset.done) : done.delete(box.dataset.done);
      renderProgress();
    }),
  );
  renderProgress();

  // ---- Troubleshooter --------------------------------------------------------

  const TROUBLE = [
    {
      s: "classmcp: command not found",
      cause: "The global install failed, or npm’s global bin folder isn’t on your PATH.",
      fix: [
        "Run <code>npm install -g gcrclassmcp@next</code> and read any error.",
        "Check <code>npm prefix -g</code> — its <code>bin</code> folder must be on PATH.",
        "Or skip PATH entirely: use absolute paths in the setup builder.",
      ],
    },
    {
      s: "Agent says classmcp failed or timed out",
      cause: "GUI apps and agents often don’t inherit your shell PATH (nvm, mise, fnm, volta), or the startup timeout is too short.",
      fix: [
        "Switch “Launch with” to <a href=\"#setup\">absolute paths</a> and use the node and cli.js paths it prints.",
        "Raise the startup timeout: Codex <code>startup_timeout_sec = 30</code>, OpenCode <code>timeout: 60000</code>, Claude Code <code>MCP_TIMEOUT=60000</code>.",
        "Restart the agent fully.",
      ],
    },
    {
      s: "“Access blocked: app has not completed verification”",
      cause: "Your OAuth app is in Testing mode and this Google account isn’t a test user.",
      fix: [
        "Open <a href=\"https://console.cloud.google.com/auth/audience\">OAuth consent screen → Audience</a>.",
        "Add the account under <strong>Test users</strong>.",
        "Run <code>classmcp setup</code> again.",
      ],
    },
    {
      s: "doctor: OAuth credentials invalid",
      cause: "The JSON file isn’t a Desktop app client (often a Web application client).",
      fix: [
        "Create a new OAuth client with type <strong>Desktop app</strong>.",
        "Download the JSON into Downloads and run <code>classmcp setup</code>.",
      ],
    },
    {
      s: "doctor: Google API call failed",
      cause: "The Classroom or Drive API isn’t enabled in your Cloud project, or your school blocks third-party access.",
      fix: [
        "Enable the <a href=\"https://console.cloud.google.com/apis/library/classroom.googleapis.com\">Classroom API</a> and <a href=\"https://console.cloud.google.com/apis/library/drive.googleapis.com\">Drive API</a>, wait a minute, retry.",
        "If the error mentions an administrator, your school’s Workspace policy blocks it — use another account or ask the admin.",
      ],
    },
    {
      s: "doctor: missing scopes or tokens not found",
      cause: "You haven’t authorized yet, or authorized with a version before 0.3.0 (no topics scope).",
      fix: ["Run <code>classmcp setup</code> to authorize again.", "Run <code>classmcp doctor</code> to confirm."],
    },
    {
      s: "OpenCode doesn’t load classmcp",
      cause: "The entry uses <code>mcpServers</code> (Claude/Cursor style) or a stale <code>opencode.json</code> overrides it.",
      fix: [
        "Use the <code>mcp</code> key, <code>type: \"local\"</code>, and a <code>command</code> array.",
        "Remove old entries that use <code>npx classmcp@…</code>.",
        "Run <code>opencode mcp list</code> — expect <code>classmcp connected</code>.",
      ],
    },
    {
      s: "A file path is refused",
      cause: "Uploads and downloads must stay inside <code>~/Downloads</code> or <code>CLASSMCP_WORKDIR</code>.",
      fix: [
        "Use a path inside Downloads, or set a work folder in the setup builder.",
        "<code>CLASSMCP_WORKDIR</code> must be in the agent’s server config, then restart the agent.",
      ],
    },
    {
      s: "submit_work returns blocked: true",
      cause: "Expected. Google only lets the project that created an assignment attach or turn in. This can’t be fixed with scopes.",
      fix: ["Your file is already in Drive.", "Open the returned <code>assignmentLink</code> and attach / turn in from Classroom."],
    },
  ];

  const symptomList = $("#symptoms");
  const fixBox = $("#fix");
  symptomList.innerHTML = TROUBLE.map(
    (t, i) => `<button type="button" role="option" aria-selected="${i === 0}" data-i="${i}">${esc(t.s)}</button>`,
  ).join("");
  function showFix(i) {
    const t = TROUBLE[i];
    $$("button", symptomList).forEach((b) => b.setAttribute("aria-selected", String(Number(b.dataset.i) === i)));
    fixBox.innerHTML = `<h3>${esc(t.s)}</h3><p class="cause">${t.cause}</p><ol>${t.fix.map((f) => `<li>${f}</li>`).join("")}</ol>`;
    fixBox.style.animation = "none";
    void fixBox.offsetWidth;
    fixBox.style.animation = "";
  }
  symptomList.addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (b) showFix(Number(b.dataset.i));
  });
  showFix(0);
})();
