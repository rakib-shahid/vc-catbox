/*
 * vcCatbox: intercept Discord file picks. ≤8MB -> let Discord upload,
 * >8MB -> upload to Catbox and send the link.
 *
 * Clipboard behavior (minimal):
 *  - Success: copy only the Catbox URL
 *  - Failure: copy a single-line error message
 */

import { findByPropsLazy } from "@webpack";
import {
  DraftType,
  SelectedChannelStore,
  Toasts,
  showToast,
} from "@webpack/common";
import { insertTextIntoChatInputBox } from "@utils/discord";
import definePlugin, { PluginNative } from "@utils/types";

const helperKey = "vcCatbox";

const Native = VencordNative?.pluginHelpers?.[helperKey] as
  | PluginNative<typeof import("./native")>
  | undefined;

const CATBOX_API = "https://catbox.moe/user/api.php";
const CATBOX_USER_HASH = ""; // optional
const EIGHT_MB = 8 * 1024 * 1024;

const UploadManager = findByPropsLazy("addFiles", "clearAll");

function fmtBytes(n?: number) {
  if (!(Number.isFinite(n!) && n! >= 0)) return "unknown";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0,
    v = n!;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 2)} ${u[i]}`;
}

function copyToClipboard(text: string) {
  try {
    // @ts-ignore
    if (globalThis.DiscordNative?.clipboard?.copy) {
      // @ts-ignore
      globalThis.DiscordNative.clipboard.copy(text);
      return;
    }
  } catch {}
  try {
    void navigator.clipboard?.writeText?.(text);
  } catch {}
}

function findEditor(): HTMLElement | null {
  return (
    document.querySelector<HTMLElement>('[data-slate-editor="true"]') ||
    document.querySelector<HTMLElement>('[role="textbox"]') ||
    document.querySelector<HTMLElement>("textarea")
  );
}

function splitSmallBig(files: FileList | File[]): {
  small: File[];
  big: File[];
} {
  const arr = Array.from(files ?? []);
  const small: File[] = [];
  const big: File[] = [];
  for (const f of arr) (f.size > EIGHT_MB ? big : small).push(f);
  return { small, big };
}

// ---------- Inject small files back into Discord ----------
async function injectSmallFiles(small: File[]) {
  if (small.length === 0) return;
  const channelId = SelectedChannelStore.getChannelId();
  if (!channelId) return;

  try {
    if (typeof UploadManager?.addFiles === "function") {
      try {
        UploadManager.addFiles(channelId, small, DraftType.Channel);
        return;
      } catch {
        UploadManager.addFiles({
          channelId,
          files: small,
          draftType: DraftType.Channel,
        });
        return;
      }
    }
  } catch {}

  const editor = findEditor();
  if (editor) {
    try {
      const dt = new DataTransfer();
      small.forEach((f) => dt.items.add(f));
      const ev = new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: dt,
      });
      editor.dispatchEvent(ev);
    } catch {}
  }
}

// ---------- Send (or insert) a message with the URL ----------
function postUrlToChat(url: string) {
  const channelId = SelectedChannelStore.getChannelId();
  if (!channelId) return;
  insertTextIntoChatInputBox(`${url} `); // insert; user can press Enter
}

// ---------- Catbox upload (prefers native) ----------
async function uploadToCatbox(file: File, userHash?: string): Promise<string> {
  const buf = await file.arrayBuffer();

  // Prefer native (no CORS, works in Electron)
  if (Native?.uploadFileToCatboxNative) {
    const text = await Native.uploadFileToCatboxNative(
      CATBOX_API,
      buf,
      file.name,
      file.type || "application/octet-stream",
      userHash ?? "",
    );
    const out = text?.trim?.() ?? "";
    if (/^https?:\/\//i.test(out)) return out;
    throw new Error(out || "Catbox returned empty response");
  }

  // If we ever get here, native wasn't built/loaded
  throw new Error("vcCatbox native helper missing (pluginHelpers['vcCatbox'])");
}

// ---------- Big file handling (upload to Catbox) ----------
async function handleBigFiles(files: File[]) {
  for (const f of files) {
    try {
      const url = await uploadToCatbox(f, CATBOX_USER_HASH || undefined);
      // Success: copy only the final link
      copyToClipboard(url);
      postUrlToChat(url);
      showToast("Catbox upload succeeded", Toasts.Type.SUCCESS);
    } catch (err: any) {
      const msg = `vcCatbox upload failed: ${f.name} (${fmtBytes(
        f.size,
      )}) — ${String(err?.message || err)}`;
      // Failure: copy the error line for quick share
      copyToClipboard(msg);
      showToast(
        "Catbox upload failed (copied error to clipboard)",
        Toasts.Type.FAILURE,
      );
    }
  }
}

// ---------- File input guards ----------
let inputObserver: MutationObserver | null = null;
const seenInputs = new WeakSet<HTMLInputElement>();

function handleFileInputChange(e: Event) {
  const input = e.currentTarget as HTMLInputElement | null;
  if (!input || !input.files) return;

  const files = Array.from(input.files);
  if (files.length === 0) return;

  const { small, big } = splitSmallBig(files);

  if (big.length === 0) {
    // All small => let Discord proceed normally
    return;
  }

  // Any big => block Discord entirely so Nitro never shows
  try {
    e.preventDefault();
  } catch {}
  try {
    (e as any).stopImmediatePropagation?.();
  } catch {}
  try {
    e.stopPropagation();
  } catch {}
  try {
    input.value = "";
  } catch {}

  // 1) pass only the small ones to Discord
  void injectSmallFiles(small);

  // 2) upload the big ones to Catbox and paste URLs
  void handleBigFiles(big);
}

function installInputGuards() {
  inputObserver = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of Array.from(m.addedNodes)) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.tagName === "INPUT" && (n as HTMLInputElement).type === "file") {
          const inp = n as HTMLInputElement;
          if (!seenInputs.has(inp)) {
            inp.addEventListener("change", handleFileInputChange, {
              capture: true,
            });
            seenInputs.add(inp);
          }
        }
        n.querySelectorAll('input[type="file"]').forEach((el) => {
          const inp = el as HTMLInputElement;
          if (!seenInputs.has(inp)) {
            inp.addEventListener("change", handleFileInputChange, {
              capture: true,
            });
            seenInputs.add(inp);
          }
        });
      }
    }
  });
  inputObserver.observe(document.body, { childList: true, subtree: true });

  // guard any pre-existing file inputs (rare)
  document
    .querySelectorAll<HTMLInputElement>('input[type="file"]')
    .forEach((inp) => {
      if (!seenInputs.has(inp)) {
        inp.addEventListener("change", handleFileInputChange, {
          capture: true,
        });
        seenInputs.add(inp);
      }
    });
}
function uninstallInputGuards() {
  try {
    inputObserver?.disconnect();
  } catch {}
  inputObserver = null;
}

// ---------- drag/drop + paste guards ----------
function onDropCapture(e: DragEvent) {
  try {
    if (!e.dataTransfer || e.dataTransfer.files.length === 0) return;
    const { small, big } = splitSmallBig(e.dataTransfer.files);
    if (big.length === 0) return; // allow normal path
    e.preventDefault();
    e.stopPropagation();
    void injectSmallFiles(small);
    void handleBigFiles(big);
  } catch {}
}
function onPasteCapture(e: ClipboardEvent) {
  try {
    const fl = e.clipboardData?.files;
    if (!fl || fl.length === 0) return;
    const { small, big } = splitSmallBig(fl);
    if (big.length === 0) return; // allow normal path
    e.preventDefault();
    e.stopPropagation();
    void injectSmallFiles(small);
    void handleBigFiles(big);
  } catch {}
}

function installEditorGuards() {
  const editor = findEditor();
  if (!editor) return;
  editor.addEventListener("drop", onDropCapture, { capture: true });
  editor.addEventListener("paste", onPasteCapture, { capture: true });
  // @ts-ignore
  (window as any).__VCCATBOX_EDITGUARD__ = { editor };
}
function uninstallEditorGuards() {
  // @ts-ignore
  const g = (window as any).__VCCATBOX_EDITGUARD__;
  const editor: HTMLElement | undefined = g?.editor;
  if (editor) {
    try {
      editor.removeEventListener("drop", onDropCapture, {
        capture: true,
      } as any);
    } catch {}
    try {
      editor.removeEventListener("paste", onPasteCapture, {
        capture: true,
      } as any);
    } catch {}
    // @ts-ignore
    delete (window as any).__VCCATBOX_EDITGUARD__;
  }
}

// Reinstall drop/paste guard when Discord swaps editors
let editorObserver: MutationObserver | null = null;

export default definePlugin({
  name: "vcCatbox",
  description:
    "≤8MB: Discord upload. >8MB: upload to Catbox and paste link. Copies only the final link (or a single-line error) to clipboard.",
  authors: [{ name: "rakib-shahid", id: 1234567890n }],

  start() {
    installInputGuards();
    installEditorGuards();

    editorObserver = new MutationObserver(() => {
      uninstallEditorGuards();
      installEditorGuards();
    });
    editorObserver.observe(document.body, { childList: true, subtree: true });
  },

  stop() {
    uninstallInputGuards();
    uninstallEditorGuards();
    try {
      editorObserver?.disconnect();
    } catch {}
    editorObserver = null;
  },
});
