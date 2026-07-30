/* Runs FFmpeg WebAssembly in a dedicated classic worker. */
const CORE_BASE = "https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd";
const CORE_JS_URL = `${CORE_BASE}/ffmpeg-core.js`;
const CORE_WASM_URL = `${CORE_BASE}/ffmpeg-core.wasm`;
let core = null;

const send = (id, result, transfer = []) => self.postMessage({ id, result }, transfer);
const fail = (id, error) => self.postMessage({ id, error: error instanceof Error ? error.message : String(error) });

async function loadCore() {
  if (core) return true;
  importScripts(CORE_JS_URL);
  if (typeof self.createFFmpegCore !== "function") throw new Error("تعذر تحميل محرك معالجة الفيديو.");

  const config = btoa(JSON.stringify({ wasmURL: CORE_WASM_URL }));
  core = await self.createFFmpegCore({ mainScriptUrlOrBlob: `${CORE_JS_URL}#${config}` });
  core.setLogger(({ type, message }) => self.postMessage({ event: "log", data: { type, message } }));
  core.setProgress(({ progress, time }) => self.postMessage({ event: "progress", data: { progress, time } }));
  return true;
}

self.onmessage = async ({ data }) => {
  const { id, type, payload = {} } = data;
  try {
    if (type !== "load" && !core) throw new Error("محرك الفيديو غير جاهز.");
    switch (type) {
      case "load":
        send(id, await loadCore());
        break;
      case "writeFile": {
        const bytes = new Uint8Array(payload.buffer);
        core.FS.writeFile(payload.path, bytes);
        send(id, true);
        break;
      }
      case "exec": {
        core.setTimeout(-1);
        core.exec(...payload.args);
        const code = core.ret;
        core.reset();
        send(id, code);
        break;
      }
      case "readFile": {
        const data = core.FS.readFile(payload.path);
        const copied = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        send(id, copied, [copied]);
        break;
      }
      case "deleteFile":
        try { core.FS.unlink(payload.path); } catch (_) { /* already absent */ }
        send(id, true);
        break;
      default:
        throw new Error("أمر غير معروف.");
    }
  } catch (error) {
    fail(id, error);
  }
};
