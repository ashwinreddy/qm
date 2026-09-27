import "./shell.css";
import "./watch.css";
import "@mariozechner/mini-lit/dist/ThemeToggle.js";
import { html, render } from "lit";
import { fetchServerSentEvents } from "@tanstack/ai-client";
import { ArrowUp, ArrowUpRight, Eye, Square, Trash2 } from "lucide";
import { api, withBase } from "./core-bridge";
import { brandName, brandMark, icon } from "./ui";
import { swallow } from "../../chassis/src/errors.ts";

interface FeedLine {
  text: string;
  kind: "meta" | "call" | "result" | "result-err" | "delta";
}

interface RunEvent {
  type?: string;
  toolCallName?: string;
  args?: Record<string, unknown>;
  content?: string;
  isError?: boolean;
  name?: string;
  value?: unknown;
}

const state = {
  runId: "",
  status: "not watching",
  live: false,
  lines: [] as FeedLine[],
};

let controller: AbortController | null = null;
let acc = "";

function appendDelta(text: string): void {
  if (!text) return;
  acc += text;
  pushLine(text, "delta");
}

function draw(): void {
  render(view(), document.getElementById("app")!);
  const feed = document.querySelector<HTMLElement>(".watch-feed");
  if (feed) feed.scrollTop = feed.scrollHeight;
}

function pushLine(text: string, kind: FeedLine["kind"]): void {
  if (kind === "delta") {
    const last = state.lines[state.lines.length - 1];
    if (last?.kind === "delta") {
      last.text += text;
      draw();
      return;
    }
  }
  state.lines.push({ text, kind });
  draw();
}

function formatArgs(args: RunEvent["args"]): string {
  if (!args) return "";
  const { path, command, cmd, action } = args as Record<string, unknown>;
  const bits = [path, command, cmd, action].filter((v): v is string => typeof v === "string" && v.length > 0);
  return bits.length ? bits.join(" ") : JSON.stringify(args).slice(0, 200);
}

function handleEvent(event: RunEvent): void {
  switch (event.type) {
    case "RUN_STARTED":
      pushLine("run started", "meta");
      return;
    case "TOOL_CALL_START":
      pushLine(`$ ${event.toolCallName ?? "tool"} ${formatArgs(event.args)}`.trimEnd(), "call");
      return;
    case "TOOL_CALL_RESULT": {
      const text = typeof event.content === "string" ? event.content : "";
      const short = text.length > 600 ? `${text.slice(0, 600)}…` : text;
      if (short.trim()) pushLine(short, event.isError ? "result-err" : "result");
      return;
    }
    case "CUSTOM": {
      if (event.name === "delta") {
        const value = event.value as { offset?: unknown; delta?: unknown } | undefined;
        if (typeof value?.offset === "number" && typeof value.delta === "string" && value.offset <= acc.length) {
          appendDelta(value.delta.slice(acc.length - value.offset));
        }
      } else if (event.name === "run") {
        const value = event.value as { status?: string; alive?: boolean; partial?: string } | undefined;
        if (typeof value?.partial === "string" && value.partial.length > acc.length) {
          appendDelta(value.partial.slice(acc.length));
        }
        if (value?.status) {
          state.status = value.status;
          state.live = !!value.alive;
          draw();
        }
      }
      return;
    }
    case "RUN_FINISHED":
      pushLine("run finished", "meta");
      state.status = "finished";
      state.live = false;
      draw();
      return;
    default:
      return;
  }
}

async function watch(runId: string): Promise<void> {
  stop();
  state.runId = runId;
  state.status = "connecting";
  state.live = false;
  state.lines = [];
  acc = "";
  draw();
  controller = new AbortController();
  const transport = fetchServerSentEvents(withBase(`/api/runs/${encodeURIComponent(runId)}/events`), {
    credentials: "same-origin",
  });
  try {
    for await (const event of transport.joinRun(runId, controller.signal)) {
      handleEvent(event as RunEvent);
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      state.status = "connection lost";
      state.live = false;
      draw();
      swallow("watch: run stream ended", err);
    }
  }
}

function stop(): void {
  controller?.abort();
  controller = null;
}

async function sendAbort(): Promise<void> {
  if (!state.runId) return;
  try {
    await api(`/api/runs/${encodeURIComponent(state.runId)}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "abort" }),
    });
    pushLine("abort sent", "meta");
  } catch (err) {
    pushLine("abort request failed", "meta");
    swallow("watch: abort failed", err);
  }
}

async function sendSteer(text: string): Promise<void> {
  if (!state.runId || !text.trim()) return;
  try {
    await api(`/api/runs/${encodeURIComponent(state.runId)}/signal`, {
      method: "POST",
      body: JSON.stringify({ kind: "steer", text }),
    });
    pushLine(`> ${text}`, "meta");
  } catch (err) {
    pushLine("steer failed to send", "meta");
    swallow("watch: steer failed", err);
  }
}

function onSteerSubmit(e: Event): void {
  e.preventDefault();
  const input = document.querySelector<HTMLInputElement>(".watch-steer-input");
  const text = input?.value.trim();
  if (!text) return;
  if (input) input.value = "";
  void sendSteer(text);
}

function clearFeed(): void {
  state.lines = [];
  draw();
}

function onSubmit(e: Event): void {
  e.preventDefault();
  const input = document.querySelector<HTMLInputElement>(".watch-run-input");
  const runId = input?.value.trim();
  if (runId) void watch(runId);
}

function view() {
  const base = (import.meta as unknown as { env: { BASE_URL: string } }).env.BASE_URL;
  return html`
    <div class="watch-page">
      <header class="chat-topbar session-topbar">
        <a class="shared-brand" href=${base} aria-label=${`Open ${brandName()}`}
          >${brandMark()}<span>${brandName()}</span></a
        >
        <div class="session-heading">
          <span class="session-title">Watch</span>
          <span class="shared-view-badge">${icon(Eye, 12)}Prototype</span>
        </div>
        <div class="topbar-actions">
          <theme-toggle .includeSystem=${true}></theme-toggle
          ><a class="btn compact" href=${base}>Open ${brandName()}${icon(ArrowUpRight, 14)}</a>
        </div>
      </header>
      <main class="watch-main">
        <form class="watch-bar" @submit=${onSubmit}>
          <input class="watch-run-input" .value=${state.runId} placeholder="runId, e.g. run_8f2a3c…" autocomplete="off" />
          <button class="btn primary" type="submit">${icon(Eye, 14)}Watch</button>
        </form>
        <div class="watch-status">
          <span class=${`watch-dot ${state.live ? "live" : ""}`}></span>
          <span>${state.runId ? `${state.status} · ${state.runId}` : "not watching"}</span>
          <div class="watch-controls">
            <button
              class="btn compact danger"
              type="button"
              ?disabled=${!state.live}
              @click=${() => void sendAbort()}
            >
              ${icon(Square, 13)}Abort
            </button>
            <button class="btn compact" type="button" @click=${clearFeed}>${icon(Trash2, 13)}Clear</button>
          </div>
        </div>
        <div class="watch-feed">
          ${state.lines.length
            ? state.lines.map((line) => html`<div class=${`watch-line ${line.kind}`}>${line.text}</div>`)
            : html`<div class="watch-placeholder">Nothing yet — paste a runId above and hit Watch.</div>`}
        </div>
        <form class="watch-bar" @submit=${onSteerSubmit}>
          <input
            class="watch-steer-input"
            placeholder="Steer this run…"
            autocomplete="off"
            ?disabled=${!state.live}
          />
          <button class="btn compact" type="submit" ?disabled=${!state.live}>${icon(ArrowUp, 13)}Steer</button>
        </form>
      </main>
    </div>
  `;
}

draw();
const runFromQuery = new URLSearchParams(location.search).get("run");
if (runFromQuery) void watch(runFromQuery);
