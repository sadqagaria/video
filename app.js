(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const MAX_SIZE = 100 * 1024 * 1024;
  const MAX_DURATION = 60;

  const RESOLUTIONS = {
    480: { landscape: [854, 480], portrait: [480, 854], square: [480, 480], portrait45: [480, 600], maxLong: 854 },
    720: { landscape: [1280, 720], portrait: [720, 1280], square: [720, 720], portrait45: [720, 900], maxLong: 1280 },
    1080: { landscape: [1920, 1080], portrait: [1080, 1920], square: [1080, 1080], portrait45: [1080, 1350], maxLong: 1920 }
  };

  const LEVELS = {
    light: {
      label: "تحسين خفيف", crf: "24",
      pre: "hqdn3d=0.8:0.8:2:2,eq=contrast=1.03:brightness=0.008:saturation=1.05:gamma=1.01",
      post: "unsharp=5:5:0.35:3:3:0"
    },
    balanced: {
      label: "تحسين متوازن", crf: "22",
      pre: "hqdn3d=1.4:1.4:4:4,eq=contrast=1.08:brightness=0.015:saturation=1.12:gamma=1.03",
      post: "unsharp=5:5:0.65:5:5:0"
    },
    strong: {
      label: "تحسين قوي", crf: "20",
      pre: "hqdn3d=2.4:2.0:6:6,eq=contrast=1.14:brightness=0.025:saturation=1.20:gamma=1.05",
      post: "unsharp=7:7:1.0:5:5:0.20"
    }
  };

  const state = {
    file: null, sourceUrl: null, resultUrl: null, resultBlob: null,
    width: 0, height: 0, duration: 0,
    resolution: 720, aspect: "auto", level: "balanced",
    running: false, cancelled: false
  };

  const els = {
    installBtn: $("installBtn"), dropZone: $("dropZone"), videoInput: $("videoInput"), chooseBtn: $("chooseBtn"),
    fileSummary: $("fileSummary"), sourcePreview: $("sourcePreview"), fileName: $("fileName"), fileSize: $("fileSize"),
    sourceResolution: $("sourceResolution"), sourceDuration: $("sourceDuration"), removeFileBtn: $("removeFileBtn"),
    optionsCard: $("optionsCard"), resolutionGrid: $("resolutionGrid"), aspectGrid: $("aspectGrid"), enhancementGrid: $("enhancementGrid"),
    autoSizeLabel: $("autoSizeLabel"), landscapeSizeLabel: $("landscapeSizeLabel"), portraitSizeLabel: $("portraitSizeLabel"),
    squareSizeLabel: $("squareSizeLabel"), portrait45SizeLabel: $("portrait45SizeLabel"), originalSizeLabel: $("originalSizeLabel"),
    outputResolution: $("outputResolution"), deviceWarning: $("deviceWarning"), enhanceBtn: $("enhanceBtn"), validationMessage: $("validationMessage"),
    progressCard: $("progressCard"), progressTitle: $("progressTitle"), progressMessage: $("progressMessage"), progressBar: $("progressBar"),
    progressPercent: $("progressPercent"), stepEngine: $("stepEngine"), stepEnhance: $("stepEnhance"), stepExport: $("stepExport"), cancelBtn: $("cancelBtn"),
    resultCard: $("resultCard"), resultPreview: $("resultPreview"), resultDescription: $("resultDescription"),
    downloadBtn: $("downloadBtn"), shareBtn: $("shareBtn"), newVideoBtn: $("newVideoBtn")
  };

  class FFmpegClient {
    constructor() {
      this.worker = null;
      this.loaded = false;
      this.seq = 0;
      this.pending = new Map();
      this.onProgress = null;
      this.onLog = null;
    }
    start() {
      if (this.worker) return;
      this.worker = new Worker("ffmpeg-worker.js");
      this.worker.onmessage = ({ data }) => {
        if (data.event === "progress") return this.onProgress?.(data.data);
        if (data.event === "log") return this.onLog?.(data.data);
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.error) pending.reject(new Error(data.error));
        else pending.resolve(data.result);
      };
      this.worker.onerror = (event) => {
        const error = new Error(event.message || "توقف محرك الفيديو داخل المتصفح.");
        for (const item of this.pending.values()) item.reject(error);
        this.pending.clear();
      };
    }
    request(type, payload = {}, transfer = []) {
      this.start();
      return new Promise((resolve, reject) => {
        const id = ++this.seq;
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ id, type, payload }, transfer);
      });
    }
    async load() {
      if (this.loaded) return;
      await this.request("load");
      this.loaded = true;
    }
    async writeFile(path, buffer) { return this.request("writeFile", { path, buffer }, [buffer]); }
    async exec(args) { return this.request("exec", { args }); }
    async readFile(path) { return this.request("readFile", { path }); }
    async deleteFile(path) { return this.request("deleteFile", { path }); }
    terminate() {
      if (this.worker) this.worker.terminate();
      this.worker = null;
      this.loaded = false;
      for (const item of this.pending.values()) item.reject(new Error("تم إلغاء العملية."));
      this.pending.clear();
    }
  }

  const ffmpeg = new FFmpegClient();
  let deferredInstallPrompt = null;

  function formatBytes(bytes) {
    if (!bytes) return "0 MB";
    const units = ["B", "KB", "MB", "GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / (1024 ** index)).toFixed(index > 1 ? 1 : 0)} ${units[index]}`;
  }
  function formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const secs = Math.round(seconds % 60);
    return `${minutes}:${String(secs).padStart(2, "0")}`;
  }
  function even(value) { return Math.max(2, Math.round(value / 2) * 2); }
  function showError(message) { els.validationMessage.textContent = message; els.validationMessage.classList.remove("hidden"); }
  function clearError() { els.validationMessage.classList.add("hidden"); }
  function selectCard(container, selector, button) {
    container.querySelectorAll(selector).forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
  }

  function outputDimensions() {
    const set = RESOLUTIONS[state.resolution];
    let aspect = state.aspect;
    if (aspect === "auto") aspect = state.width >= state.height ? "landscape" : "portrait";
    if (aspect !== "original") return set[aspect];
    if (!state.width || !state.height) return [set.maxLong, even(set.maxLong * 9 / 16)];
    if (state.width >= state.height) return [set.maxLong, even(set.maxLong * state.height / state.width)];
    return [even(set.maxLong * state.width / state.height), set.maxLong];
  }

  function updateLabels() {
    const set = RESOLUTIONS[state.resolution];
    els.landscapeSizeLabel.textContent = `${set.landscape[0]} × ${set.landscape[1]}`;
    els.portraitSizeLabel.textContent = `${set.portrait[0]} × ${set.portrait[1]}`;
    els.squareSizeLabel.textContent = `${set.square[0]} × ${set.square[1]}`;
    els.portrait45SizeLabel.textContent = `${set.portrait45[0]} × ${set.portrait45[1]}`;
    const auto = state.width >= state.height ? set.landscape : set.portrait;
    els.autoSizeLabel.textContent = state.width ? `${auto[0]} × ${auto[1]}` : "حسب اتجاه الفيديو";
    const original = outputDimensions();
    els.originalSizeLabel.textContent = state.width ? `${original[0]} × ${original[1]}` : "يحافظ على النسبة الأصلية";
    const [w, h] = outputDimensions();
    els.outputResolution.textContent = `${w} × ${h} — ${LEVELS[state.level].label}`;

    const heavy = state.resolution === 1080 && (state.level === "strong" || state.duration > 25);
    const lowMemory = navigator.deviceMemory && navigator.deviceMemory < 4;
    if (heavy || lowMemory) {
      els.deviceWarning.textContent = lowMemory
        ? "هاتفك قد تكون ذاكرته محدودة. ابدأ بـ720p وفيديو قصير لتجنب توقف الصفحة."
        : "1080p مع التحسين القوي يحتاج وقتًا وذاكرة أكبر. يُفضّل أن يكون الفيديو أقل من 20–30 ثانية.";
      els.deviceWarning.classList.remove("hidden");
    } else {
      els.deviceWarning.classList.add("hidden");
    }
  }

  async function handleFile(file) {
    clearError();
    if (!file || !file.type.startsWith("video/")) return showError("اختر ملف فيديو صالحًا.");
    if (file.size > MAX_SIZE) return showError("حجم الفيديو أكبر من 100MB. استخدم فيديو أصغر حتى لا تتوقف ذاكرة الهاتف.");
    cleanupSource();
    state.file = file;
    state.sourceUrl = URL.createObjectURL(file);
    els.sourcePreview.src = state.sourceUrl;
    try {
      await new Promise((resolve, reject) => {
        els.sourcePreview.onloadedmetadata = resolve;
        els.sourcePreview.onerror = () => reject(new Error("تعذر قراءة بيانات الفيديو."));
      });
      state.width = els.sourcePreview.videoWidth;
      state.height = els.sourcePreview.videoHeight;
      state.duration = els.sourcePreview.duration || 0;
      if (state.duration > MAX_DURATION) {
        cleanupSource();
        return showError("مدة الفيديو أكبر من 60 ثانية. قص الفيديو أولًا ثم أعد المحاولة.");
      }
      els.fileName.textContent = file.name;
      els.fileSize.textContent = formatBytes(file.size);
      els.sourceResolution.textContent = `${state.width} × ${state.height}`;
      els.sourceDuration.textContent = formatDuration(state.duration);
      els.dropZone.classList.add("hidden");
      els.fileSummary.classList.remove("hidden");
      els.optionsCard.classList.remove("hidden");
      els.resultCard.classList.add("hidden");
      updateLabels();
      setTimeout(() => els.optionsCard.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    } catch (error) {
      cleanupSource();
      showError(error.message);
    }
  }

  function cleanupSource() {
    if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
    state.sourceUrl = null;
    state.file = null;
    state.width = 0; state.height = 0; state.duration = 0;
    els.sourcePreview.removeAttribute("src");
    els.sourcePreview.load();
  }
  function cleanupResult() {
    if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = null; state.resultBlob = null;
    els.resultPreview.removeAttribute("src");
    els.resultPreview.load();
  }
  function resetUI() {
    cleanupSource(); cleanupResult(); clearError();
    els.videoInput.value = "";
    els.fileSummary.classList.add("hidden");
    els.optionsCard.classList.add("hidden");
    els.progressCard.classList.add("hidden");
    els.resultCard.classList.add("hidden");
    els.dropZone.classList.remove("hidden");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function setProgress(value, title, message, step) {
    const pct = Math.max(0, Math.min(100, Math.round(value)));
    els.progressBar.style.width = `${pct}%`;
    els.progressPercent.textContent = `${pct}%`;
    if (title) els.progressTitle.textContent = title;
    if (message) els.progressMessage.textContent = message;
    [els.stepEngine, els.stepEnhance, els.stepExport].forEach((item) => item.className = "");
    if (step === "engine") els.stepEngine.classList.add("active");
    if (step === "enhance") { els.stepEngine.classList.add("done"); els.stepEnhance.classList.add("active"); }
    if (step === "export") { els.stepEngine.classList.add("done"); els.stepEnhance.classList.add("done"); els.stepExport.classList.add("active"); }
    if (step === "done") [els.stepEngine, els.stepEnhance, els.stepExport].forEach((item) => item.classList.add("done"));
  }

  function inputExtension(file) {
    const ext = file.name.split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "");
    if (ext && ext.length <= 5) return ext;
    if (file.type.includes("quicktime")) return "mov";
    if (file.type.includes("webm")) return "webm";
    return "mp4";
  }

  function buildCommand(inputName, outputName) {
    const [w, h] = outputDimensions();
    const level = LEVELS[state.level];
    const fit = document.querySelector('input[name="fitMode"]:checked').value;
    const commonOutput = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", level.crf, "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "128k", "-shortest", outputName];

    if (state.aspect === "original") {
      const vf = `${level.pre},scale=${w}:${h}:flags=lanczos,${level.post},format=yuv420p`;
      return ["-i", inputName, "-map", "0:v:0", "-map", "0:a?", "-vf", vf, ...commonOutput];
    }
    if (fit === "fill") {
      const vf = `${level.pre},scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},${level.post},format=yuv420p`;
      return ["-i", inputName, "-map", "0:v:0", "-map", "0:a?", "-vf", vf, ...commonOutput];
    }
    if (fit === "blur") {
      const graph = `[0:v]split=2[bg][fg];[bg]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=bilinear,crop=${w}:${h},boxblur=20:2[bg2];[fg]${level.pre},scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,${level.post}[fg2];[bg2][fg2]overlay=(W-w)/2:(H-h)/2:shortest=1,format=yuv420p[v]`;
      return ["-i", inputName, "-filter_complex", graph, "-map", "[v]", "-map", "0:a?", ...commonOutput];
    }
    const vf = `${level.pre},scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,${level.post},format=yuv420p`;
    return ["-i", inputName, "-map", "0:v:0", "-map", "0:a?", "-vf", vf, ...commonOutput];
  }

  async function enhanceVideo() {
    clearError();
    if (!state.file || state.running) return;
    if (!window.WebAssembly || !window.Worker) return showError("المتصفح الحالي لا يدعم معالجة الفيديو. استخدم أحدث إصدار من Chrome على Android.");

    state.running = true; state.cancelled = false;
    els.enhanceBtn.disabled = true;
    els.optionsCard.classList.add("hidden");
    els.resultCard.classList.add("hidden");
    els.progressCard.classList.remove("hidden");
    setProgress(2, "جاري تجهيز محرك التحسين…", "أول تشغيل يحتاج تنزيل محرك بحجم يقارب 25MB.", "engine");
    els.progressCard.scrollIntoView({ behavior: "smooth", block: "start" });

    let inputName = ""; const outputName = "enhanced.mp4";
    try {
      ffmpeg.onLog = ({ message }) => console.debug("FFmpeg:", message);
      ffmpeg.onProgress = ({ progress }) => {
        if (!Number.isFinite(progress)) return;
        setProgress(18 + Math.max(0, Math.min(1, progress)) * 72, "جاري تحسين الفيديو…", "أبقِ الصفحة مفتوحة ولا تنتقل إلى تطبيق آخر.", "enhance");
      };
      await ffmpeg.load();
      if (state.cancelled) throw new Error("تم إلغاء العملية.");
      setProgress(12, "جاري قراءة الفيديو…", "يتم تجهيز الملف داخل ذاكرة الهاتف.", "engine");

      inputName = `input.${inputExtension(state.file)}`;
      const buffer = await state.file.arrayBuffer();
      await ffmpeg.writeFile(inputName, buffer);
      if (state.cancelled) throw new Error("تم إلغاء العملية.");

      setProgress(18, "جاري تحسين الفيديو…", "التنقية والوضوح والألوان ثم تغيير المقاس.", "enhance");
      const exitCode = await ffmpeg.exec(buildCommand(inputName, outputName));
      if (exitCode !== 0) throw new Error(`فشلت المعالجة (رمز ${exitCode}). جرّب 720p أو تحسينًا أخف.`);
      if (state.cancelled) throw new Error("تم إلغاء العملية.");

      setProgress(93, "جاري تجهيز الملف النهائي…", "لحظات ويتم إنشاء رابط التحميل.", "export");
      const outputBuffer = await ffmpeg.readFile(outputName);
      cleanupResult();
      state.resultBlob = new Blob([outputBuffer], { type: "video/mp4" });
      state.resultUrl = URL.createObjectURL(state.resultBlob);
      els.resultPreview.src = state.resultUrl;
      const [w, h] = outputDimensions();
      const filename = `enhanced-${state.resolution}p-${state.level}.mp4`;
      els.downloadBtn.href = state.resultUrl;
      els.downloadBtn.download = filename;
      els.resultDescription.textContent = `${w} × ${h} — ${LEVELS[state.level].label} — ${formatBytes(state.resultBlob.size)}`;
      if (navigator.share && navigator.canShare) els.shareBtn.classList.remove("hidden");
      setProgress(100, "تم الانتهاء", "الفيديو جاهز للتحميل.", "done");
      await new Promise((resolve) => setTimeout(resolve, 450));
      els.progressCard.classList.add("hidden");
      els.resultCard.classList.remove("hidden");
      els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      els.progressCard.classList.add("hidden");
      els.optionsCard.classList.remove("hidden");
      if (!state.cancelled) showError(normalizeError(error));
      else showError("تم إلغاء العملية. يمكنك تغيير الإعدادات والمحاولة مرة أخرى.");
      els.optionsCard.scrollIntoView({ behavior: "smooth", block: "start" });
    } finally {
      state.running = false;
      els.enhanceBtn.disabled = false;
      if (ffmpeg.loaded) {
        if (inputName) ffmpeg.deleteFile(inputName).catch(() => {});
        ffmpeg.deleteFile(outputName).catch(() => {});
      }
    }
  }

  function normalizeError(error) {
    const text = error?.message || String(error);
    if (/memory|abort\(|out of bounds|allocation/i.test(text)) return "ذاكرة الهاتف لم تكفِ لهذه العملية. جرّب فيديو أقصر أو اختر 720p / 480p وتحسينًا أخف.";
    if (/fetch|network|load|importscripts/i.test(text)) return "تعذر تنزيل محرك التحسين. تأكد من اتصال الإنترنت ثم أعد المحاولة. المحرك يُنزّل مرة واحدة عند بدء المعالجة.";
    if (/codec|decoder|invalid data/i.test(text)) return "صيغة أو ترميز الفيديو غير مدعوم. جرّب فيديو MP4 بترميز H.264.";
    return text || "حدث خطأ أثناء تحسين الفيديو.";
  }

  els.chooseBtn.addEventListener("click", (event) => { event.stopPropagation(); els.videoInput.click(); });
  els.dropZone.addEventListener("click", (event) => { if (event.target !== els.chooseBtn) els.videoInput.click(); });
  els.dropZone.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") els.videoInput.click(); });
  els.videoInput.addEventListener("change", () => handleFile(els.videoInput.files[0]));
  ["dragenter", "dragover"].forEach((name) => els.dropZone.addEventListener(name, (event) => { event.preventDefault(); els.dropZone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((name) => els.dropZone.addEventListener(name, (event) => { event.preventDefault(); els.dropZone.classList.remove("dragover"); }));
  els.dropZone.addEventListener("drop", (event) => handleFile(event.dataTransfer.files[0]));
  els.removeFileBtn.addEventListener("click", resetUI);

  els.resolutionGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-resolution]"); if (!button) return;
    state.resolution = Number(button.dataset.resolution);
    selectCard(els.resolutionGrid, "[data-resolution]", button); updateLabels();
  });
  els.aspectGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-aspect]"); if (!button) return;
    state.aspect = button.dataset.aspect;
    selectCard(els.aspectGrid, "[data-aspect]", button); updateLabels();
  });
  els.enhancementGrid.addEventListener("click", (event) => {
    const button = event.target.closest("[data-level]"); if (!button) return;
    state.level = button.dataset.level;
    selectCard(els.enhancementGrid, "[data-level]", button); updateLabels();
  });
  document.querySelectorAll('input[name="fitMode"]').forEach((input) => input.addEventListener("change", updateLabels));
  els.enhanceBtn.addEventListener("click", enhanceVideo);
  els.cancelBtn.addEventListener("click", () => {
    if (!state.running) return;
    state.cancelled = true;
    ffmpeg.terminate();
  });
  els.newVideoBtn.addEventListener("click", resetUI);
  els.shareBtn.addEventListener("click", async () => {
    if (!state.resultBlob) return;
    const file = new File([state.resultBlob], els.downloadBtn.download, { type: "video/mp4" });
    try {
      if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file], title: "الفيديو المحسّن" });
      else els.downloadBtn.click();
    } catch (error) { if (error.name !== "AbortError") showError("تعذرت المشاركة؛ استخدم زر التحميل."); }
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault(); deferredInstallPrompt = event; els.installBtn.classList.remove("hidden");
  });
  els.installBtn.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null; els.installBtn.classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => els.installBtn.classList.add("hidden"));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  updateLabels();
})();
