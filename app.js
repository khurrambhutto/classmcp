const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

/* ---------- header state ------------------------------------------------- */

const header = document.getElementById("site-header");
const onScroll = () => {
  header.classList.toggle("is-scrolled", window.scrollY > 6);
};
onScroll();
window.addEventListener("scroll", onScroll, { passive: true });

/* ---------- mobile menu -------------------------------------------------- */

const menuButton = document.getElementById("menu-button");
const mobileNav = document.getElementById("mobile-nav");

function setMenu(open) {
  menuButton.setAttribute("aria-expanded", String(open));
  menuButton.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  mobileNav.hidden = !open;
}

menuButton.addEventListener("click", () => {
  setMenu(menuButton.getAttribute("aria-expanded") !== "true");
});

mobileNav.addEventListener("click", (event) => {
  if (event.target.closest("a")) setMenu(false);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
    setMenu(false);
    menuButton.focus();
  }
});

window.addEventListener("resize", () => {
  if (window.innerWidth > 900) setMenu(false);
});

/* ---------- current section in the nav ----------------------------------- */

const navLinks = [...document.querySelectorAll(".site-nav a[href^='#']")];
const navSections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

let navFrame = 0;

function updateNav() {
  navFrame = 0;
  const line = window.innerHeight * 0.35;
  let current = null;
  for (const section of navSections) {
    if (section.getBoundingClientRect().top <= line) current = section;
  }
  for (const link of navLinks) {
    link.classList.toggle(
      "is-current",
      Boolean(current) && link.getAttribute("href") === `#${current.id}`,
    );
  }
}

function queueNav() {
  if (!navFrame) navFrame = requestAnimationFrame(updateNav);
}

updateNav();
window.addEventListener("scroll", queueNav, { passive: true });
window.addEventListener("resize", queueNav);

/* ---------- board reveal ------------------------------------------------- */

const board = document.querySelector(".board");
if (board) {
  if (reducedMotion.matches || !("IntersectionObserver" in window)) {
    board.classList.add("is-visible");
  } else {
    const boardObserver = new IntersectionObserver(
      (entries, observer) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.classList.add("is-visible");
          observer.disconnect();
        }
      },
      { threshold: 0.16 },
    );
    boardObserver.observe(board);
  }
}

/* ---------- copy buttons -------------------------------------------------- */

const toast = document.getElementById("copy-status");
let toastTimeout;

function announce(message) {
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.classList.add("is-visible");
  toastTimeout = setTimeout(() => toast.classList.remove("is-visible"), 3600);
}

function legacyCopy(text) {
  const field = document.createElement("textarea");
  field.value = text;
  field.style.position = "fixed";
  field.style.opacity = "0";
  field.setAttribute("aria-label", "Text to copy");
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
  }
}

const copyTimeouts = new WeakMap();

for (const button of document.querySelectorAll("[data-copy]")) {
  button.addEventListener("click", async () => {
    const source = document.getElementById(button.dataset.copy);
    if (!source) return;
    const text = source.textContent.trim();
    let copied = false;

    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      // Denied permission or an insecure context falls through to the fallback.
    }

    if (!copied) copied = legacyCopy(text);

    button.focus({ preventScroll: true });

    if (!copied) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(source);
      selection.removeAllRanges();
      selection.addRange(range);
      announce("Copy is blocked. The text is selected — use your browser’s Copy command.");
      return;
    }

    clearTimeout(copyTimeouts.get(button));
    button.classList.add("is-copied");
    const label = button.querySelector("span");
    if (label && !button.dataset.originalLabel) {
      button.dataset.originalLabel = label.textContent;
    }
    if (label) label.textContent = "Copied";

    announce(
      button.dataset.copy === "agent-prompt"
        ? "Setup prompt copied. Paste it into your agent."
        : "Copied to clipboard.",
    );

    copyTimeouts.set(
      button,
      setTimeout(() => {
        button.classList.remove("is-copied");
        if (label) label.textContent = button.dataset.originalLabel;
      }, 2200),
    );
  });
}

/* ---------- the demo session --------------------------------------------- */

const demo = {
  week: {
    question: "What’s due this week?",
    answer: `<p>You have <strong>3 assignments</strong> coming up. Here’s the week:</p>
<div class="assignments">
  <div class="assignment">
    <span class="subject physics" aria-hidden="true"><svg class="icon"><use href="#i-file"/></svg></span>
    <div><strong>Waves &amp; sound lab</strong><span>Physics</span></div>
    <span class="due is-soon">Tomorrow</span>
  </div>
  <div class="assignment">
    <span class="subject literature" aria-hidden="true"><svg class="icon"><use href="#i-file"/></svg></span>
    <div><strong>The art of persuasion</strong><span>English literature</span></div>
    <span class="due">Thursday</span>
  </div>
  <div class="assignment">
    <span class="subject maths" aria-hidden="true"><svg class="icon"><use href="#i-file"/></svg></span>
    <div><strong>Practice set 04</strong><span>Mathematics</span></div>
    <span class="due">Friday</span>
  </div>
</div>
<p class="followup">Want me to download the lab handout so you can start tonight?</p>`,
    trace: [
      ["→", "get_overview", '{ view: "courses" }'],
      ["←", "", "4 courses · 96 ms"],
      ["→", "get_overview", '{ view: "due", window: 7 }'],
      ["←", "", "3 due · 187 ms"],
    ],
  },
  find: {
    question: "Find the waves and sound lab.",
    answer: `<p>Found it in <strong>Physics</strong>. Here’s what you need:</p>
<div class="detail">
  <strong>Waves &amp; sound lab</strong>
  <p>Investigate how frequency affects wavelength. Record your observations and explain the relationship using your results.</p>
  <span class="detail-meta"><svg class="icon" aria-hidden="true"><use href="#i-calendar"/></svg>Due tomorrow · 1 attachment</span>
</div>
<div class="assignment">
  <span class="subject physics" aria-hidden="true"><svg class="icon"><use href="#i-file"/></svg></span>
  <div><strong>Lab instructions.pdf</strong><span>Assignment attachment</span></div>
</div>
<p class="followup">I can download the instructions whenever you’re ready.</p>`,
    trace: [
      ["→", "search", '{ query: "waves and sound lab" }'],
      ["←", "", "1 match · 240 ms"],
      ["→", "get_assignment", '{ courseId: "72…", assignmentId: "91…" }'],
      ["←", "", "1 rubric · 1 attachment · 132 ms"],
    ],
  },
  download: {
    question: "Download the Physics lab handout.",
    answer: `<p>The handout is saved to your <strong>Downloads</strong> folder.</p>
<div class="download-row">
  <span class="subject physics" aria-hidden="true"><svg class="icon"><use href="#i-file"/></svg></span>
  <div><strong>Lab instructions.pdf</strong><span>Downloads/classmcp/Lab instructions.pdf</span></div>
  <svg class="icon check" aria-hidden="true"><use href="#i-check"/></svg>
</div>
<p class="followup">Ready to open on your computer. Want to read it together?</p>
<div class="detail">
  <strong>Google file? No problem.</strong>
  <p>Docs, Sheets, and Slides export to editable formats, or download as PDF.</p>
</div>`,
    trace: [
      ["→", "get_assignment", '{ assignmentId: "91…" }'],
      ["←", "", "1 attachment · 108 ms"],
      ["→", "download_files", '{ fileIds: ["1x9…"], destinationDir: "~/Downloads" }'],
      ["←", "", "Lab instructions.pdf · 1.2 MB · 640 ms"],
    ],
  },
};

const questionNode = document.getElementById("demo-question");
const answerNode = document.getElementById("demo-answer");
const traceNode = document.getElementById("trace-lines");
const demoButtons = [...document.querySelectorAll("[data-demo]")];

function renderTrace(lines) {
  traceNode.replaceChildren(
    ...lines.map(([call, name, text]) => {
      const item = document.createElement("li");
      const arrow = document.createElement("span");
      arrow.className = "call";
      arrow.textContent = call;
      item.append(arrow);
      if (name) {
        const code = document.createElement("code");
        code.textContent = name;
        item.append(code);
      }
      const detail = document.createElement("span");
      detail.className = call === "→" ? "args" : "result";
      detail.textContent = text;
      item.append(detail);
      return item;
    }),
  );
}

for (const button of demoButtons) {
  button.addEventListener("click", () => {
    const example = demo[button.dataset.demo];
    if (!example) return;

    for (const item of demoButtons) {
      item.setAttribute("aria-pressed", String(item === button));
    }

    questionNode.textContent = example.question;
    answerNode.innerHTML = example.answer;
    renderTrace(example.trace);

    if (!reducedMotion.matches) {
      for (const turn of document.querySelectorAll(".turn")) {
        turn.classList.remove("demo-enter");
        void turn.offsetWidth;
        turn.classList.add("demo-enter");
      }
    }
  });
}

/* ---------- host tabs ----------------------------------------------------- */

const hostInstructions = {
  codex: {
    instruction: "Run in your terminal:",
    label: "Terminal",
    code: "codex mcp add classmcp -- classmcp serve\ncodex mcp list",
    hint: "Restart or reconnect Codex after registering the server.",
  },
  opencode: {
    instruction: "Merge this entry into ~/.config/opencode/opencode.jsonc:",
    label: "opencode.jsonc",
    code: '{\n  "mcp": {\n    "classmcp": {\n      "type": "local",\n      "command": ["classmcp", "serve"],\n      "enabled": true,\n      "timeout": 60000\n    }\n  }\n}',
    hint: "Keep existing entries and comments. Run opencode mcp list to check the connection. If the command is not found, use absolute Node and dist/cli.js paths.",
  },
  claude: {
    instruction: "Run in your terminal:",
    label: "Terminal",
    code: "claude mcp add classmcp -- classmcp serve",
    hint: "Reconnect Claude Code after registering the server. This example has not been validated live for this release candidate.",
  },
  cursor: {
    instruction: "Merge this entry into ~/.cursor/mcp.json:",
    label: "mcp.json",
    code: '{\n  "mcpServers": {\n    "classmcp": {\n      "command": "classmcp",\n      "args": ["serve"]\n    }\n  }\n}',
    hint: "Keep your existing MCP servers, then reconnect in Cursor’s MCP settings. This example has not been validated live for this release candidate.",
  },
  other: {
    instruction: "Register a local MCP server in your host with these values:",
    label: "Server settings",
    code: "Name:       classmcp\nTransport:  stdio\nCommand:    classmcp\nArguments:  serve",
    hint: "Use the globally installed command or stable absolute paths. For Antigravity, use Cursor’s JSON shape in ~/.config/antigravity/mcp.json.",
  },
};

const tabs = [...document.querySelectorAll("[data-host]")];

function selectHost(tab) {
  const host = hostInstructions[tab.dataset.host];
  if (!host) return;

  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
  }

  document.getElementById("host-panel").setAttribute("aria-labelledby", tab.id);
  document.getElementById("host-instruction").textContent = host.instruction;
  document.getElementById("host-code-label").textContent = host.label;
  document.getElementById("host-command").textContent = host.code;
  document.getElementById("host-hint").textContent = host.hint;
}

for (const tab of tabs) {
  tab.addEventListener("click", () => selectHost(tab));
  tab.addEventListener("keydown", (event) => {
    const current = tabs.indexOf(tab);
    let next;
    if (event.key === "ArrowRight") next = (current + 1) % tabs.length;
    if (event.key === "ArrowLeft") next = (current - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = tabs.length - 1;
    if (next === undefined) return;
    event.preventDefault();
    selectHost(tabs[next]);
    tabs[next].focus();
  });
}
