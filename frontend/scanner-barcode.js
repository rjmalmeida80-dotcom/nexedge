/**
 * NexEdge — Scanner de Código de Barras
 * Usa câmara do browser via BarcodeDetector API ou ZXing fallback
 * Para WMS: picking, recepção, inventário
 */
class NexScanner {
  constructor(options = {}) {
    this.onResult = options.onResult || (() => {});
    this.onError = options.onError || (() => {});
    this.modal = null;
    this.stream = null;
    this.scanning = false;
    this.detector = null;
    this.animFrame = null;
  }

  async init() {
    // Verificar suporte
    if ('BarcodeDetector' in window) {
      try {
        const formatos = await BarcodeDetector.getSupportedFormats();
        this.detector = new BarcodeDetector({ formats: formatos });
        return true;
      } catch(e) {}
    }
    // Fallback — tentar carregar ZXing
    if (!window.ZXing) {
      await this._carregarScript('https://cdn.jsdelivr.net/npm/@zxing/browser@0.1.4/umd/index.min.js');
    }
    return true;
  }

  async abrir(titulo = 'Scan código de barras') {
    await this.init();
    this._criarModal(titulo);
    await this._iniciarCamera();
  }

  _criarModal(titulo) {
    const div = document.createElement('div');
    div.id = 'nx-scanner-modal';
    div.innerHTML = `
      <div style="position:fixed;inset:0;background:rgba(0,0,0,.9);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px">
        <div style="background:#0F172A;border:1px solid rgba(255,255,255,.1);border-radius:20px;overflow:hidden;width:100%;max-width:400px">
          <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:space-between">
            <div style="font-family:Inter,sans-serif;font-size:14px;font-weight:700;color:#f8fafc">📷 ${titulo}</div>
            <button onclick="window._nxScanner.fechar()" style="background:none;border:none;color:#94a3b8;font-size:20px;cursor:pointer">×</button>
          </div>
          <div style="position:relative;background:#000;aspect-ratio:4/3">
            <video id="nx-scan-video" autoplay playsinline muted style="width:100%;height:100%;object-fit:cover"></video>
            <canvas id="nx-scan-canvas" style="display:none"></canvas>
            <!-- Overlay mira -->
            <div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none">
              <div style="width:200px;height:120px;border:3px solid #10b981;border-radius:12px;box-shadow:0 0 0 9999px rgba(0,0,0,.4)">
                <div style="position:absolute;top:-2px;left:-2px;width:20px;height:20px;border-top:3px solid #10b981;border-left:3px solid #10b981;border-radius:3px 0 0 0"></div>
                <div style="position:absolute;top:-2px;right:-2px;width:20px;height:20px;border-top:3px solid #10b981;border-right:3px solid #10b981;border-radius:0 3px 0 0"></div>
                <div style="position:absolute;bottom:-2px;left:-2px;width:20px;height:20px;border-bottom:3px solid #10b981;border-left:3px solid #10b981;border-radius:0 0 0 3px"></div>
                <div style="position:absolute;bottom:-2px;right:-2px;width:20px;height:20px;border-bottom:3px solid #10b981;border-right:3px solid #10b981;border-radius:0 0 3px 0"></div>
              </div>
            </div>
            <!-- Linha animada -->
            <div id="nx-scan-line" style="position:absolute;left:calc(50% - 100px);width:200px;height:2px;background:linear-gradient(90deg,transparent,#10b981,transparent);animation:nxScan 2s linear infinite"></div>
          </div>
          <style>@keyframes nxScan{0%{top:calc(50% - 60px)}100%{top:calc(50% + 60px)}}</style>
          <div style="padding:14px 20px">
            <div id="nx-scan-status" style="font-family:Inter,sans-serif;font-size:12px;color:#94a3b8;text-align:center;margin-bottom:10px">A iniciar câmara...</div>
            <div style="display:flex;gap:8px">
              <input id="nx-manual-input" placeholder="Ou introduzir código manualmente..." 
                style="flex:1;background:#1E293B;border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:10px 14px;font-size:13px;color:#f8fafc;font-family:Inter,sans-serif;outline:none"
                onkeydown="if(event.key==='Enter')window._nxScanner._manualSubmit()"/>
              <button onclick="window._nxScanner._manualSubmit()" 
                style="background:#10b981;border:none;border-radius:10px;padding:10px 16px;color:#fff;font-size:13px;font-weight:600;cursor:pointer;font-family:Inter,sans-serif">OK</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(div);
    this.modal = div;
    window._nxScanner = this;
  }

  async _iniciarCamera() {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } }
      });
      const video = document.getElementById('nx-scan-video');
      video.srcObject = this.stream;
      await video.play();
      document.getElementById('nx-scan-status').textContent = '📷 A aguardar código...';
      this.scanning = true;
      this._loop();
    } catch(e) {
      document.getElementById('nx-scan-status').textContent = '⚠️ Sem acesso à câmara — usa o campo manual';
      this.onError(e);
    }
  }

  async _loop() {
    if (!this.scanning) return;
    const video = document.getElementById('nx-scan-video');
    const canvas = document.getElementById('nx-scan-canvas');

    if (video.readyState === video.HAVE_ENOUGH_DATA) {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      try {
        if (this.detector) {
          const codes = await this.detector.detect(video);
          if (codes.length > 0) { this._resultado(codes[0].rawValue); return; }
        } else if (window.ZXing) {
          // ZXing fallback
          const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
          // Implementação simplificada — em produção usar ZXing completo
        }
      } catch(e) {}
    }
    this.animFrame = requestAnimationFrame(() => this._loop());
  }

  _resultado(codigo) {
    this.scanning = false;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    // Som de beep
    try {
      const ctx = new(window.AudioContext||window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 1200; gain.gain.value = 0.2;
      osc.start(); osc.stop(ctx.currentTime + 0.08);
    } catch(e) {}
    document.getElementById('nx-scan-status').textContent = `✅ Lido: ${codigo}`;
    document.getElementById('nx-scan-status').style.color = '#10b981';
    setTimeout(() => { this.fechar(); this.onResult(codigo); }, 500);
  }

  _manualSubmit() {
    const val = document.getElementById('nx-manual-input')?.value?.trim();
    if (val) this._resultado(val);
  }

  fechar() {
    this.scanning = false;
    if (this.animFrame) cancelAnimationFrame(this.animFrame);
    if (this.stream) { this.stream.getTracks().forEach(t=>t.stop()); this.stream = null; }
    this.modal?.remove();
    this.modal = null;
    window._nxScanner = null;
  }

  _carregarScript(src) {
    return new Promise(res => {
      const s = document.createElement('script'); s.src = src; s.onload = res; document.head.appendChild(s);
    });
  }
}

// Função global de conveniência
window.NexScanner = NexScanner;
window.nexScan = function(titulo, callback) {
  const scanner = new NexScanner({ onResult: callback });
  scanner.abrir(titulo);
  return scanner;
};
