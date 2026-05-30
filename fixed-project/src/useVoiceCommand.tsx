// useVoiceCommand.ts
// Web Speech API (mic) + Gemini AI untuk parse perintah Bahasa Indonesia → MQTT command

import { useState, useRef, useCallback } from 'react';

export interface VoiceResult {
  transcript: string;
  command: string | null;
  label: string;
  isError: boolean;
  source?: 'gemini' | 'fallback';
}

// ─── Kirim transcript ke Gemini AI ─────────────────────────────────────────
async function parseWithGemini(transcript: string): Promise<{ command: string | null; label: string; source: 'gemini' | 'fallback' }> {
  const apiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || '';

  const prompt = `Kamu adalah parser perintah suara untuk sistem IoT Smart Light berbasis ESP32.
Tugasmu: ubah teks ucapan pengguna menjadi salah satu MQTT command yang valid.

DAFTAR COMMAND VALID:
- r1_on / r1_off   → relay 1 nyala / mati
- r2_on / r2_off   → relay 2 nyala / mati
- r3_on / r3_off   → relay 3 nyala / mati
- r4_on / r4_off   → relay 4 nyala / mati
- all_on           → semua relay nyala
- all_off          → semua relay mati
- v1_on            → Variasi 1 (Disco) aktif
- v2_on            → Variasi 2 (Bertahap) aktif
- v_stop           → hentikan variasi
- get_sensor       → baca suhu dan kelembapan

CONTOH MAPPING:
"nyalakan lampu"         → all_on
"matikan semua lampu"    → all_off
"hidupkan relay satu"    → r1_on
"matikan relay 3"        → r3_off
"berapa suhu sekarang"   → get_sensor
"berapa kelembapan"      → get_sensor
"nyalakan mode disco"    → v1_on
"variasi dua aktif"      → v2_on
"stop variasi"           → v_stop
"nyalakan lampu satu"    → r1_on
"padamkan relay empat"   → r4_off
"matikan relay dua"      → r2_off

INPUT PENGGUNA: "${transcript}"

Jawab HANYA dengan JSON (tanpa markdown, tanpa backtick):
{"command":"COMMAND_DISINI","label":"Deskripsi singkat aksi dalam Bahasa Indonesia"}

Jika tidak ada yang cocok: {"command":null,"label":"Perintah tidak dikenali"}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
        }),
      }
    );
    if (!res.ok) throw new Error(`Gemini error: ${res.status}`);
    const data = await res.json();
    const raw  = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const clean = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);
    return { command: parsed.command ?? null, label: parsed.label ?? 'Tidak dikenali', source: 'gemini' };
  } catch (err) {
    console.warn('Gemini gagal, pakai fallback NLP:', err);
    const fallback = fallbackParse(transcript);
    return { ...fallback, source: 'fallback' };
  }
}

// ─── Fallback NLP lokal jika Gemini tidak tersedia / API key kosong ─────────
function fallbackParse(text: string): { command: string | null; label: string } {
  const t = text.toLowerCase();
  const on  = /nyala|hidup|aktif|on|mulai/.test(t);
  const off = /mati|padam|nonaktif|off|henti|stop/.test(t);

  if (/suhu|temperatur|panas|kelembap|lembab/.test(t))
    return { command: 'get_sensor', label: '🌡️ Baca suhu & kelembapan' };

  if (/variasi.*(1|satu|disco)|disco/.test(t) && on)
    return { command: 'v1_on', label: '🕺 Variasi 1 (Disco) aktif' };
  if (/variasi.*(2|dua|bertahap)|bertahap/.test(t) && on)
    return { command: 'v2_on', label: '🌅 Variasi 2 (Bertahap) aktif' };
  if (/(stop|henti).*variasi|variasi.*(stop|henti)/.test(t))
    return { command: 'v_stop', label: '⏹️ Variasi dihentikan' };

  if (on  && /semua|all/.test(t)) return { command: 'all_on',  label: '💡 Semua relay ON' };
  if (off && /semua|all/.test(t)) return { command: 'all_off', label: '🌑 Semua relay OFF' };

  const numMap: Record<string, number> = {
    satu: 1, '1': 1, dua: 2, '2': 2, tiga: 3, '3': 3, empat: 4, '4': 4,
  };
  for (const [k, n] of Object.entries(numMap)) {
    if (t.includes(k)) {
      if (on)  return { command: `r${n}_on`,  label: `💡 Relay ${n} ON`  };
      if (off) return { command: `r${n}_off`, label: `🌑 Relay ${n} OFF` };
    }
  }

  if (on)  return { command: 'all_on',  label: '💡 Semua relay ON' };
  if (off) return { command: 'all_off', label: '🌑 Semua relay OFF' };

  return { command: null, label: '❓ Perintah tidak dikenali' };
}

// ─── Hook utama ──────────────────────────────────────────────────────────────
export function useVoiceCommand(onCommand: (cmd: string) => void) {
  const [isListening,  setIsListening]  = useState(false);
  const [status, setStatus] = useState<'idle' | 'listening' | 'processing'>('idle');
  const [transcript, setTranscript] = useState('');
  const [lastResult, setLastResult] = useState<VoiceResult | null>(null);

  const recognitionRef     = useRef<any>(null);
  const finalTranscriptRef = useRef('');

  const startListening = useCallback(() => {
    const SR =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;

    if (!SR) {
      alert('Browser tidak mendukung Web Speech API. Gunakan Chrome atau Edge.');
      return;
    }

    setTranscript('');
    setLastResult(null);
    finalTranscriptRef.current = '';

    const rec = new SR();
    rec.lang           = 'id-ID';
    rec.interimResults = true;
    rec.continuous     = false;

    rec.onstart = () => {
      setIsListening(true);
      setStatus('listening');
    };

    rec.onresult = (e: any) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalTranscriptRef.current += chunk;
        else interim += chunk;
      }
      setTranscript(finalTranscriptRef.current + interim);
    };

    rec.onend = async () => {
      setIsListening(false);
      const final = finalTranscriptRef.current.trim();
      if (!final) {
        setStatus('idle');
        return;
      }

      setTranscript(final);
      setStatus('processing');
      const { command, label, source } = await parseWithGemini(final);
      setStatus('idle');

      const res: VoiceResult = { transcript: final, command, label, isError: !command, source };
      setLastResult(res);
      if (command) onCommand(command);
    };

    rec.onerror = (e: any) => {
      setIsListening(false);
      setStatus('idle');
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        console.warn(`Mic error: ${e.error}`);
      }
    };

    recognitionRef.current = rec;
    rec.start();
  }, [onCommand]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    setIsListening(false);
    setStatus('idle');
  }, []);

  // Simulate a voice command (for testing via example buttons)
  const simulateVoice = useCallback(async (text: string) => {
    setTranscript(text);
    setStatus('processing');
    const { command, label, source } = await parseWithGemini(text);
    setStatus('idle');
    const res: VoiceResult = { transcript: text, command, label, isError: !command, source };
    setLastResult(res);
    if (command) onCommand(command);
  }, [onCommand]);

  return {
    isListening,
    status,
    transcript,
    lastResult,
    startListening,
    stopListening,
    simulateVoice,
  };
}
