"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { pickVoice } from "@/lib/audio-player-context";
import {
  CodingAgentSchema,
  CodingChatArchiveSchema,
  CodingModeSchema,
  CODING_MODE_LABELS,
  type CodingAgent,
  type CodingFile,
  type CodingMode,
  type CodingStoredMessage,
} from "@/lib/coding-chat";
import {
  buildNexusGreetingResponse,
  buildNexusSpokenResponse,
  cleanNexusVoiceText,
  createNexusVoiceRecognition,
  extractNexusWakeCommand,
  getNexusRecognitionText,
  isNexusGreeting,
  splitNexusVoiceText,
  type NexusVoiceRecognition,
} from "@/lib/nexuslm-voice";

const STORAGE_KEY = "nexus-coding-chat";
const VOICE_STORAGE_KEY = "nexus-coding-voice-mode";
const MAX_FILE_SIZE = 500_000;
const MAX_FILES = 12;

type CodingVoiceStatus = "off" | "waiting" | "capturing" | "thinking" | "speaking" | "error";

function voiceStatusLabel(status: CodingVoiceStatus): string {
  return status === "waiting"
    ? "Listening for Nexus"
    : status === "capturing"
      ? "Listening for your instruction"
      : status === "thinking"
        ? "Nexus is thinking"
        : status === "speaking"
          ? "Nexus is speaking"
          : status === "error"
            ? "Voice mode needs attention"
            : "Voice mode off";
}

const INITIAL_MESSAGE: CodingStoredMessage = {
  id: "coding-welcome",
  role: "system",
  content: "Nexus Code is ready. Attach source files and describe what you want to build, debug, review, or explain.",
  createdAt: new Date().toISOString(),
  fileNames: [],
};

function languageFromName(name: string): string | undefined {
  const extension = name.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  const languages: Record<string, string> = {
    css: "css",
    go: "go",
    html: "html",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    md: "markdown",
    mjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sql: "sql",
    ts: "typescript",
    tsx: "tsx",
    yaml: "yaml",
    yml: "yaml",
  };
  return languages[extension];
}

function renderAssistantContent(content: string) {
  const parts = content.split(/```([^\n]*)\n([\s\S]*?)```/g);
  const rendered: React.ReactNode[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (index % 3 === 0) {
      if (parts[index]) rendered.push(
        <p key={`text-${index}`} className="whitespace-pre-wrap">{parts[index]}</p>,
      );
      continue;
    }
    if (index % 3 === 1) {
      rendered.push(
        <div key={`code-${index}`} className="mt-3 overflow-hidden rounded-xl border border-cyan-500/20 bg-slate-950">
          <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-cyan-300">
            {parts[index] || "code"}
          </div>
          <pre className="max-h-[50dvh] overflow-auto p-3 text-xs leading-5 text-slate-200"><code>{parts[index + 1]}</code></pre>
        </div>,
      );
    }
  }
  return rendered;
}

export function CodingChatPanel() {
  const [messages, setMessages] = useState<CodingStoredMessage[]>([INITIAL_MESSAGE]);
  const [files, setFiles] = useState<CodingFile[]>([]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<CodingMode>("ask");
  const [agent, setAgent] = useState<CodingAgent>("deepseek-chat");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<CodingVoiceStatus>("off");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const voiceModeRef = useRef(false);
  const voiceRecognitionRef = useRef<NexusVoiceRecognition | null>(null);
  const voiceSessionRef = useRef(0);
  const voiceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceCommandRef = useRef("");
  const voiceInstructionRef = useRef("");
  const speechGenerationRef = useRef(0);
  const speechUnlockedRef = useRef(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = CodingChatArchiveSchema.safeParse(JSON.parse(raw) as unknown);
      if (parsed.success && parsed.data.messages.length > 0) setMessages(parsed.data.messages);
    } catch {
      setError("Saved coding conversation could not be loaded.");
    }
  }, []);

  const clearVoiceRestartTimer = useCallback(() => {
    if (!voiceRestartTimerRef.current) return;
    clearTimeout(voiceRestartTimerRef.current);
    voiceRestartTimerRef.current = null;
  }, []);

  const clearVoiceResumeTimer = useCallback(() => {
    if (!voiceResumeTimerRef.current) return;
    clearTimeout(voiceResumeTimerRef.current);
    voiceResumeTimerRef.current = null;
  }, []);

  const stopVoiceRecognition = useCallback(() => {
    voiceSessionRef.current += 1;
    const recognition = voiceRecognitionRef.current;
    voiceRecognitionRef.current = null;
    if (!recognition) return;
    try {
      recognition.abort();
    } catch {
      setVoiceError("Voice recognition could not be stopped cleanly.");
    }
  }, []);

  const stopVoiceOutput = useCallback(() => {
    speechGenerationRef.current += 1;
    clearVoiceResumeTimer();
    if (typeof window !== "undefined") window.speechSynthesis?.cancel();
  }, [clearVoiceResumeTimer]);

  const persistVoiceMode = useCallback((enabled: boolean) => {
    try {
      window.localStorage.setItem(VOICE_STORAGE_KEY, enabled ? "on" : "off");
    } catch {
      setVoiceError("Voice mode preference could not be saved.");
    }
  }, []);

  const failVoiceMode = useCallback((message: string) => {
    voiceModeRef.current = false;
    setVoiceModeEnabled(false);
    persistVoiceMode(false);
    stopVoiceRecognition();
    stopVoiceOutput();
    clearVoiceRestartTimer();
    setVoiceStatus("error");
    setVoiceError(message);
  }, [clearVoiceRestartTimer, persistVoiceMode, stopVoiceOutput, stopVoiceRecognition]);

  const scheduleWakeRecognition = useCallback(() => {
    if (!voiceModeRef.current || voiceRestartTimerRef.current) return;
    voiceRestartTimerRef.current = setTimeout(() => {
      voiceRestartTimerRef.current = null;
      startWakeRecognition();
    }, 250);
  }, []);

  const speakVoiceNotice = useCallback((text: string, onFinished?: () => void) => {
    if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
      setVoiceError("Spoken responses are not supported in this browser. Written responses will continue normally.");
      onFinished?.();
      return;
    }
    stopVoiceOutput();
    window.speechSynthesis.resume();
    const utterance = new SpeechSynthesisUtterance(text);
    const voice = pickVoice(window.speechSynthesis.getVoices());
    if (voice) utterance.voice = voice;
    utterance.onstart = () => { speechUnlockedRef.current = true; };
    utterance.onend = () => {
      speechUnlockedRef.current = true;
      onFinished?.();
    };
    utterance.onerror = () => {
      setVoiceError("Nexus could not start spoken responses. Tap the mic again to enable audio.");
      onFinished?.();
    };
    window.speechSynthesis.speak(utterance);
  }, [stopVoiceOutput]);

  const finishVoiceSpeech = useCallback((generation: number) => {
    if (generation !== speechGenerationRef.current || !voiceModeRef.current) return;
    if (typeof window !== "undefined" && (window.speechSynthesis?.speaking || window.speechSynthesis?.pending)) {
      clearVoiceResumeTimer();
      voiceResumeTimerRef.current = setTimeout(() => finishVoiceSpeech(generation), 1000);
      return;
    }
    clearVoiceResumeTimer();
    setVoiceStatus("waiting");
    scheduleWakeRecognition();
  }, [clearVoiceResumeTimer, scheduleWakeRecognition]);

  const speakAssistantResponse = useCallback((content: string) => {
    if (!voiceModeRef.current) return;
    if (typeof window === "undefined" || !window.speechSynthesis || typeof SpeechSynthesisUtterance === "undefined") {
      setVoiceError("Spoken responses are not supported in this browser. Written responses will continue normally.");
      setVoiceStatus("waiting");
      scheduleWakeRecognition();
      return;
    }
    const spokenResponse = buildNexusSpokenResponse(content, voiceInstructionRef.current);
    const chunks = splitNexusVoiceText(spokenResponse);
    if (chunks.length === 0) {
      setVoiceStatus("waiting");
      scheduleWakeRecognition();
      return;
    }
    stopVoiceOutput();
    window.speechSynthesis.resume();
    const generation = speechGenerationRef.current;
    let chunkIndex = 0;
    setVoiceStatus("speaking");
    const speakNext = () => {
      if (generation !== speechGenerationRef.current || !voiceModeRef.current) return;
      if (chunkIndex >= chunks.length) {
        finishVoiceSpeech(generation);
        return;
      }
      const utterance = new SpeechSynthesisUtterance(chunks[chunkIndex]);
      chunkIndex += 1;
      const voice = pickVoice(window.speechSynthesis.getVoices());
      if (voice) utterance.voice = voice;
      utterance.rate = 1;
      utterance.pitch = 1;
      utterance.onend = speakNext;
      utterance.onerror = () => finishVoiceSpeech(generation);
      window.speechSynthesis.speak(utterance);
    };
    voiceResumeTimerRef.current = setTimeout(
      () => finishVoiceSpeech(generation),
      Math.min(120_000, Math.max(4_000, cleanNexusVoiceText(content).length * 65 + 2_000)),
    );
    speakNext();
  }, [finishVoiceSpeech, scheduleWakeRecognition, stopVoiceOutput]);

  function startWakeRecognition(): void {
    if (!voiceModeRef.current) return;
    clearVoiceRestartTimer();
    stopVoiceRecognition();
    const recognition = createNexusVoiceRecognition();
    if (!recognition) {
      failVoiceMode("Voice mode is not supported in this browser. Try Safari or Chrome with microphone access enabled.");
      return;
    }
    const session = voiceSessionRef.current;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      if (session !== voiceSessionRef.current || !voiceModeRef.current) return;
      const { isFinal, transcript } = getNexusRecognitionText(event);
      if (!isFinal) return;
      const command = extractNexusWakeCommand(transcript);
      if (command === null) return;
      if (command) submitVoiceCommand(command);
      else startVoiceCommandCapture();
    };
    recognition.onerror = (event) => {
      if (session !== voiceSessionRef.current || !voiceModeRef.current) return;
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setVoiceError(event.message || "Nexus could not hear the wake command.");
      }
    };
    recognition.onend = () => {
      if (session !== voiceSessionRef.current || !voiceModeRef.current) return;
      voiceRecognitionRef.current = null;
      scheduleWakeRecognition();
    };
    voiceRecognitionRef.current = recognition;
    setVoiceStatus("waiting");
    setVoiceError(null);
    try {
      recognition.start();
    } catch {
      failVoiceMode("Voice recognition could not start. Tap the mic again.");
    }
  }

  function startVoiceCommandCapture(initialCommand = ""): void {
    if (!voiceModeRef.current) return;
    clearVoiceRestartTimer();
    stopVoiceRecognition();
    const recognition = createNexusVoiceRecognition();
    if (!recognition) {
      failVoiceMode("Voice command capture is not supported in this browser.");
      return;
    }
    const session = voiceSessionRef.current;
    voiceCommandRef.current = initialCommand;
    setInput(initialCommand);
    setVoiceStatus("capturing");
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onresult = (event) => {
      if (session !== voiceSessionRef.current || !voiceModeRef.current) return;
      const { transcript } = getNexusRecognitionText(event);
      if (!transcript) return;
      voiceCommandRef.current = transcript.slice(0, 12_000);
      setInput(voiceCommandRef.current);
    };
    recognition.onerror = (event) => {
      if (session !== voiceSessionRef.current || !voiceModeRef.current) return;
      if (event.error !== "no-speech" && event.error !== "aborted") {
        setVoiceError(event.message || "Nexus could not capture that instruction.");
      }
    };
    recognition.onend = () => {
      if (session !== voiceSessionRef.current || !voiceModeRef.current) return;
      voiceRecognitionRef.current = null;
      const command = voiceCommandRef.current.trim();
      if (command) submitVoiceCommand(command);
      else {
        setVoiceStatus("waiting");
        scheduleWakeRecognition();
      }
    };
    voiceRecognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      failVoiceMode("Voice recognition could not start. Tap the mic again.");
    }
  }

  function handleVoiceControlCommand(command: string): boolean {
    const normalized = command.replace(/[?.!]+$/, "").trim().toLowerCase();
    const modeMatch = normalized.match(/^(?:switch|change|set|use)(?:\s+to)?\s+(ask|plan|code)(?:\s+mode)?$/);
    if (!modeMatch) return false;
    const nextMode = CodingModeSchema.parse(modeMatch[1]);
    setMode(nextMode);
    setVoiceStatus("waiting");
    speakVoiceNotice(`${CODING_MODE_LABELS[nextMode].label} mode enabled.`, scheduleWakeRecognition);
    return true;
  }

  function submitVoiceCommand(command: string): void {
    const normalized = command.replace(/\s+/g, " ").trim().slice(0, 12_000);
    stopVoiceRecognition();
    voiceCommandRef.current = "";
    if (!normalized) {
      setVoiceStatus("waiting");
      scheduleWakeRecognition();
      return;
    }
    if (/^(cancel|never mind)$/i.test(normalized)) {
      setInput("");
      setVoiceStatus("waiting");
      scheduleWakeRecognition();
      return;
    }
    if (/^(stop listening|turn off voice mode)$/i.test(normalized)) {
      stopVoiceMode();
      return;
    }
    voiceInstructionRef.current = normalized;
    if (handleVoiceControlCommand(normalized)) {
      setInput("");
      return;
    }
    if (isNexusGreeting(normalized)) {
      const greeting = buildNexusGreetingResponse(normalized);
      setMessages((current) => [...current, {
        id: `assistant-${Date.now()}`,
        role: "assistant",
        content: greeting,
        createdAt: new Date().toISOString(),
        fileNames: [],
      }]);
      setInput("");
      speakAssistantResponse(greeting);
      return;
    }
    if (loading) {
      setVoiceError("Nexus Code is still responding. Wait for it to finish before giving another instruction.");
      setVoiceStatus("waiting");
      scheduleWakeRecognition();
      return;
    }
    setInput(normalized);
    setVoiceStatus("thinking");
    void send(normalized);
  }

  function stopVoiceMode(): void {
    voiceModeRef.current = false;
    setVoiceModeEnabled(false);
    persistVoiceMode(false);
    stopVoiceRecognition();
    stopVoiceOutput();
    speechUnlockedRef.current = false;
    clearVoiceRestartTimer();
    setVoiceStatus("off");
    setVoiceError(null);
  }

  function toggleVoiceMode(): void {
    if (voiceModeRef.current) {
      if (!speechUnlockedRef.current) {
        setVoiceError(null);
        setVoiceStatus("speaking");
        speakVoiceNotice("Nexus voice mode is on.", () => {
          if (!voiceModeRef.current) return;
          setVoiceStatus("waiting");
          startWakeRecognition();
        });
        return;
      }
      stopVoiceMode();
      return;
    }
    if (!createNexusVoiceRecognition()) {
      setVoiceStatus("error");
      setVoiceError("Voice mode is not supported in this browser. Try Safari or Chrome with microphone access enabled.");
      return;
    }
    voiceModeRef.current = true;
    setVoiceModeEnabled(true);
    persistVoiceMode(true);
    setVoiceError(null);
    setVoiceStatus("speaking");
    speakVoiceNotice("Nexus voice mode is on.", () => {
      if (!voiceModeRef.current) return;
      setVoiceStatus("waiting");
      startWakeRecognition();
    });
  }

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: loading ? "auto" : "smooth" });
    try {
      const archive = CodingChatArchiveSchema.parse({
        messages: messages.slice(-80),
        updatedAt: new Date().toISOString(),
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(archive));
    } catch {
      setError("Coding conversation could not be saved locally.");
    }
  }, [loading, messages]);

  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setStatus("Ready");
    setError(null);
    setMessages([{ ...INITIAL_MESSAGE, createdAt: new Date().toISOString() }]);
  }, []);

  useEffect(() => {
    let shouldRestore = false;
    try {
      shouldRestore = window.localStorage.getItem(VOICE_STORAGE_KEY) === "on";
    } catch {
      setVoiceError("Voice mode preference could not be loaded.");
    }
    if (!shouldRestore) return;
    voiceModeRef.current = true;
    setVoiceModeEnabled(true);
    setVoiceError("Tap the microphone once to enable spoken responses on this device.");
    const timer = window.setTimeout(() => startWakeRecognition(), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => () => {
    voiceModeRef.current = false;
    stopVoiceRecognition();
    stopVoiceOutput();
    clearVoiceRestartTimer();
    clearVoiceResumeTimer();
  }, [clearVoiceRestartTimer, clearVoiceResumeTimer, stopVoiceOutput, stopVoiceRecognition]);

  const addFiles = useCallback(async (selected: FileList | null) => {
    if (!selected) return;
    const incoming = Array.from(selected);
    if (files.length + incoming.length > MAX_FILES) {
      setError(`Attach no more than ${MAX_FILES} source files.`);
      return;
    }
    const nextFiles: CodingFile[] = [];
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name} is too large. Keep each file under 500 KB.`);
        continue;
      }
      nextFiles.push({
        name: file.name,
        content: await file.text(),
        language: languageFromName(file.name),
      });
    }
    setFiles((current) => [...current, ...nextFiles]);
    if (nextFiles.length > 0) setError(null);
  }, [files.length]);

  const send = useCallback(async (requestedQuery?: string) => {
    const query = (requestedQuery ?? input).trim();
    if (!query || loading) return;
    voiceInstructionRef.current = query;
    setLoading(true);
    setStatus("Nexus Code is working");
    setError(null);
    const userMessage: CodingStoredMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: query,
      createdAt: new Date().toISOString(),
      fileNames: files.map((file) => file.name),
    };
    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: CodingStoredMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      fileNames: [],
    };
    const requestHistory = messages
      .filter((message): message is CodingStoredMessage & { role: "user" | "assistant" } => message.role !== "system")
      .slice(-20)
      .map((message) => ({ role: message.role, content: message.content }));
    setMessages((current) => [...current, userMessage, assistantMessage]);
    setInput("");
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const response = await fetch("/api/coding/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, mode, agent, history: requestHistory, files }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof payload?.error === "string" ? payload.error : "Nexus Code could not answer.");
      }
      if (!response.body) throw new Error("Nexus Code returned no response stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let content = "";
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        content += decoder.decode(result.value, { stream: true });
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content } : message
        )));
      }
      content += decoder.decode();
      setMessages((current) => current.map((message) => (
        message.id === assistantId ? { ...message, content: content || "Nexus Code returned an empty response." } : message
      )));
      if (content) speakAssistantResponse(content);
      setStatus("Ready");
    } catch (requestError) {
      if (requestError instanceof DOMException && requestError.name === "AbortError") {
        setStatus("Stopped");
      } else {
        setStatus("Needs attention");
        setError(requestError instanceof Error ? requestError.message : "Nexus Code request failed.");
        setMessages((current) => current.filter((message) => message.id !== assistantId));
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [agent, files, input, loading, messages, mode, speakAssistantResponse]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-950/70 shadow-panel" aria-label="Nexus Code workspace">
      <header className="shrink-0 border-b border-cyan-500/20 bg-slate-950/80 px-3 py-3 backdrop-blur sm:px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">Dedicated coding pipeline</p>
            <h1 className="mt-1 truncate text-base font-bold text-slate-100 sm:text-lg">Nexus Code</h1>
            <p className="mt-1 text-xs text-slate-500">DeepSeek Chat default · R1 available for difficult reasoning</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${loading ? "border-amber-400/40 text-amber-300" : "border-emerald-400/30 text-emerald-300"}`}>
              {status}
            </div>
            <button type="button" onClick={clearConversation} className="min-h-12 rounded-xl px-2 text-xs font-semibold text-slate-500 hover:bg-slate-800 hover:text-slate-200">
              Clear
            </button>
          </div>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 lg:px-8" style={{ WebkitOverflowScrolling: "touch" }}>
        <div className="mx-auto flex max-w-5xl flex-col gap-4">
          {messages.map((message) => (
            <article
              key={message.id}
              className={message.role === "user"
                ? "max-w-[92%] self-end rounded-2xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-3 text-sm leading-6 text-cyan-50"
                : message.role === "system"
                  ? "rounded-2xl border border-cyan-500/20 bg-cyan-950/20 px-4 py-3 text-sm leading-6 text-slate-300"
                  : "rounded-2xl border border-slate-800 bg-slate-900/60 px-4 py-4 text-sm leading-6 text-slate-200"}
            >
              <div className="mb-2 flex items-center justify-between gap-3 text-[10px] font-bold uppercase tracking-widest text-slate-500">
                <span>{message.role === "user" ? "You" : message.role === "system" ? "Pipeline" : "Nexus Code"}</span>
                {message.fileNames.length > 0 && <span className="truncate text-cyan-400">{message.fileNames.join(", ")}</span>}
              </div>
              {message.role === "assistant" ? renderAssistantContent(message.content || "Thinking…") : (
                <p className="whitespace-pre-wrap">{message.content}</p>
              )}
            </article>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-slate-500" aria-live="polite">
              <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-400" />
              DeepSeek is generating a coding response…
            </div>
          )}
        </div>
      </div>

      <div className="shrink-0 bg-slate-950/90 p-3 sm:p-4" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}>
        {(error || voiceError) && (
          <p role="alert" className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {error || voiceError}
          </p>
        )}
        <div className="rounded-2xl border border-slate-700/80 bg-slate-900/65 p-2 sm:p-3">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".c,.cpp,.css,.go,.html,.java,.js,.json,.jsx,.md,.mjs,.py,.rb,.rs,.sql,.ts,.tsx,.txt,.yaml,.yml"
            className="hidden"
            onChange={(event) => {
              void addFiles(event.target.files);
              event.target.value = "";
            }}
          />
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={loading}
            rows={3}
            placeholder="Describe the feature, bug, or code you want Nexus to work on…"
            className="min-h-24 w-full resize-none border-0 bg-transparent px-2 py-2 text-base leading-6 text-slate-100 placeholder:text-slate-600 focus:outline-none disabled:opacity-50"
          />
          {files.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-slate-800 px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {files.map((file) => (
                <button key={file.name} type="button" onClick={() => setFiles((current) => current.filter((item) => item.name !== file.name))} className="min-h-12 max-w-48 shrink-0 truncate rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 text-xs text-cyan-200">
                  {file.name} ×
                </button>
              ))}
            </div>
          )}
          <div className="mt-2 flex items-center gap-2 overflow-x-auto border-t border-slate-800 px-1 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-widest text-slate-500">Mode</span>
            {(Object.keys(CODING_MODE_LABELS) as CodingMode[]).map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setMode(CodingModeSchema.parse(item))}
                className={`min-h-12 shrink-0 rounded-xl border px-3 text-xs font-bold ${mode === item ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200" : "border-slate-700 bg-slate-950/70 text-slate-400"}`}
                aria-label={`${CODING_MODE_LABELS[item].label} mode`}
              >
                {CODING_MODE_LABELS[item].label}
              </button>
            ))}
            <select
              value={agent}
              onChange={(event) => setAgent(CodingAgentSchema.parse(event.target.value))}
              aria-label="DeepSeek coding model"
              className="min-h-12 min-w-[6.5rem] shrink-0 rounded-xl border border-slate-700 bg-slate-950/70 px-2 text-base text-slate-300 focus:border-violet-400/60 focus:outline-none"
            >
              <option value="deepseek-chat">Chat</option>
              <option value="deepseek-reasoner">R1</option>
            </select>
            <button type="button" onClick={() => fileInputRef.current?.click()} className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-950/70 text-lg text-slate-300" aria-label="Attach code">
              +
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={voiceModeEnabled}
              onClick={toggleVoiceMode}
              aria-label={voiceModeEnabled ? "Turn Nexus voice mode off" : "Turn Nexus voice mode on"}
              title={voiceModeEnabled ? voiceStatusLabel(voiceStatus) : "Turn on Nexus voice mode"}
              className={`relative flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-xl border text-xs font-semibold ${voiceModeEnabled ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200" : "border-slate-700 text-slate-400"}`}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-2">
                <path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3Z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="sr-only">{voiceModeEnabled ? "Nexus voice mode on" : "Nexus voice mode off"}</span>
              {voiceModeEnabled && <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-cyan-300" aria-hidden="true" />}
            </button>
            {voiceModeEnabled && <span className="shrink-0 text-[10px] text-cyan-300">{voiceStatusLabel(voiceStatus)}</span>}
            <button
              type="button"
              onClick={loading ? stop : () => void send()}
              disabled={!loading && !input.trim()}
              className={`ml-auto min-h-12 shrink-0 rounded-xl px-4 text-sm font-bold ${loading ? "border border-rose-400/40 bg-rose-500/10 text-rose-200" : "bg-cyan-400 text-slate-950 disabled:bg-slate-700 disabled:text-slate-500"}`}
              aria-label={loading ? "Stop response" : "Send coding request"}
            >
              {loading ? "Stop" : "Send"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-slate-600">Ctrl/⌘ + Enter to send · attached files are used as coding context</p>
      </div>
    </section>
  );
}
