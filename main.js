require("dotenv").config();
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const Groq = require("groq-sdk");

if (!process.env.GROQ_API_KEY) throw new Error("Falta GROQ_API_KEY en .env");

const TMP_WEBM = path.join(__dirname, "charvis_tmp.webm");
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
/** Pausa después de que termina toda la voz de Charvis antes de tu próximo turno (evita solapamiento). */
const MIC_REOPEN_DELAY_MS = 900;

let historial = [];
function crearSesionChat() {
  historial = [
    {
      role: "system",
      content:
        "Sos Charvis, asistente por turnos: el usuario habla, espera, y solo entonces vos respondes una vez hasta el final. No te interrumpas ni pidas que hablen encima tuyo. Una sola respuesta completa por turno, en espanol rioplatense, natural y directo. Sin listas ni markdown. Maximo 3 oraciones. No hagas preguntas al final que obliguen a contestar de inmediato.",
    },
  ];
}
crearSesionChat();

let win = null;
let procesando = false;
let activo = false;
let esperandoFinVoz = false;
let abortController = null;

function crearVentana() {
  win = new BrowserWindow({
    width: 480,
    height: 700,
    resizable: false,
    frame: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, preload: path.join(__dirname, "preload.js") },
    backgroundColor: "#0a0a0f",
  });
  win.loadFile("index.html");
}

app.whenReady().then(crearVentana);
app.on("window-all-closed", () => app.quit());

/** Única señal al renderer: si puede iniciar VAD / enviar clips. */
function setMicGate(permitido) {
  win?.webContents.send("micGate", !!permitido);
}

function abortarPeticionActual() {
  try {
    abortController?.abort();
  } catch (_) {}
  abortController = null;
}

function normalizarTextoEco(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whisper a veces transcribe lo que suena por los parlantes (despedidas cortas, eco).
 * Comparamos con la ultima respuesta del asistente de forma agresiva para textos cortos.
 */
function transcripcionEsEcoDeAsistente(transcripcion, ultimoAsistente) {
  const t = normalizarTextoEco(transcripcion);
  const a = normalizarTextoEco(ultimoAsistente);
  if (t.length < 2 || a.length < 4) return false;
  if (a.includes(t) && t.length >= 3) return true;
  if (t.includes(a) && a.length >= 8) return true;
  const palabrasT = t.split(" ").filter((w) => w.length > 1);
  if (palabrasT.length === 0) return false;
  let enAsistente = 0;
  for (const w of palabrasT) {
    if (a.includes(w)) enAsistente++;
  }
  if (palabrasT.length <= 5 && enAsistente === palabrasT.length) return true;
  if (palabrasT.length > 5 && enAsistente / palabrasT.length >= 0.52) return true;
  return false;
}

async function ejecutarConversacionDesdeTexto() {
  win?.webContents.send("estado", "pensando");
  esperandoFinVoz = true;

  abortController = new AbortController();
  const signal = abortController.signal;

  const stream = await groq.chat.completions.create(
    {
      model: "llama-3.3-70b-versatile",
      messages: historial,
      max_tokens: 200,
      stream: true,
    },
    { signal }
  );

  let respuestaCompleta = "";
  let bufferTexto = "";
  const CORTE = /[.!?,;]+\s/;
  win?.webContents.send("estado", "hablando");

  for await (const chunk of stream) {
    if (signal.aborted) throw new Error("aborted");
    const token = chunk.choices[0]?.delta?.content || "";
    if (!token) continue;
    respuestaCompleta += token;
    bufferTexto += token;
    if (CORTE.test(bufferTexto)) {
      const match = bufferTexto.match(CORTE);
      const idx = bufferTexto.indexOf(match[0]) + match[0].length;
      const frase = bufferTexto.slice(0, idx).trim();
      esperandoFinVoz = true;
      bufferTexto = bufferTexto.slice(idx);
      if (frase) win?.webContents.send("hablar", frase);
    }
  }
  if (bufferTexto.trim()) {
    win?.webContents.send("hablar", bufferTexto.trim());
    esperandoFinVoz = true;
  }
  if (!respuestaCompleta.trim()) esperandoFinVoz = false;

  historial.push({ role: "assistant", content: respuestaCompleta });
  win?.webContents.send("mensaje", { rol: "charvis", texto: respuestaCompleta });
  win?.webContents.send("streamTerminado");
}

async function procesarAudioWebm(buf) {
  if (!activo || procesando) return;
  if (!buf || buf.length < 2000) return;

  procesando = true;
  try {
    win?.webContents.send("estado", "transcribiendo");
    fs.writeFileSync(TMP_WEBM, Buffer.from(buf));

    const transcripcion = await groq.audio.transcriptions.create({
      file: fs.createReadStream(TMP_WEBM),
      model: "whisper-large-v3",
      language: "es",
    });
    const texto = transcripcion.text.trim();
    console.log("[CHARVIS] Transcripcion:", JSON.stringify(texto));

    if (!texto) throw new Error("No se detecto texto.");

    const ultimoAsistente = [...historial].reverse().find((m) => m.role === "assistant")?.content || "";
    if (transcripcionEsEcoDeAsistente(texto, ultimoAsistente)) {
      console.log("[CHARVIS] Eco ignorado.");
      return;
    }

    historial.push({ role: "user", content: texto });
    win?.webContents.send("mensaje", { rol: "usuario", texto });

    await ejecutarConversacionDesdeTexto();
  } catch (err) {
    const aborted = err.message === "aborted" || err.name === "AbortError";
    if (!aborted) {
      console.error("[ERROR]", err.message);
      win?.webContents.send("error", err.message);
      if (historial.length && historial[historial.length - 1].role === "user") historial.pop();
    }
    esperandoFinVoz = false;
  } finally {
    abortController = null;
    if (fs.existsSync(TMP_WEBM)) {
      try {
        fs.unlinkSync(TMP_WEBM);
      } catch (_) {}
    }
    win?.webContents.send("estado", "listo");
    procesando = false;
    if (activo && !esperandoFinVoz) setMicGate(true);
  }
}

ipcMain.on("iniciar", () => {
  activo = true;
  setMicGate(true);
});

ipcMain.on("detener", () => {
  activo = false;
  abortarPeticionActual();
  esperandoFinVoz = false;
  procesando = false;
  setMicGate(false);
  win?.webContents.send("detenerVoz");
  win?.webContents.send("estado", "detenido");
});

ipcMain.on("interrumpir", () => {
  abortarPeticionActual();
  esperandoFinVoz = false;
  procesando = false;
  win?.webContents.send("detenerVoz");
  win?.webContents.send("estado", "listo");
});

ipcMain.on("audio", (_, data) => {
  if (!activo || procesando) return;
  setMicGate(false);
  procesarAudioWebm(data);
});

ipcMain.on("limpiar", () => {
  abortarPeticionActual();
  crearSesionChat();
  esperandoFinVoz = false;
  procesando = false;
  win?.webContents.send("limpiar");
  win?.webContents.send("detenerVoz");
  win?.webContents.send("estado", "listo");
  if (activo) setMicGate(true);
});

ipcMain.on("vozTerminada", () => {
  esperandoFinVoz = false;
  if (activo && !procesando) {
    setTimeout(() => setMicGate(true), MIC_REOPEN_DELAY_MS);
  }
});

ipcMain.on("cerrar", () => app.quit());
ipcMain.on("minimizar", () => win?.minimize());
