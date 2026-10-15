"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  buildCodingGreetingResponse,
  buildCodingSpokenResponse,
  cleanCodingVoiceText,
  createCodingVoiceRecognition,
  extractCodingWakeCommand,
  getCodingRecognitionText,
  isCodingGreeting,
  splitCodingVoiceText,
  type CodingVoiceRecognition,
} from "@/lib/coding-voice";
import {
  CodingAgentEventSchema,
  CodingPreviewSchema,
  CodingWorkspaceSchema,
  CodingWorkspaceSnapshotSchema,
  codingLanguageFromName,
  extractCodingFiles,
  type CodingAgentEvent,
  type CodingPreview,
  type CodingWorkspace,
  type CodingWorkspaceSnapshot,
} from "@/lib/coding-workspace";
import {
  bootCodingWebContainer,
  CodingWebContainerCommandSchema,
  CodingPreviewRuntimeSchema,
  CodingWebContainerOutputSchema,
  CodingWebContainerReadySchema,
  CodingWebContainerStatusSchema,
  createCodingWebContainerFileTree,
  teardownCodingWebContainer,
  type CodingWebContainerStatus,
} from "@/lib/coding-webcontainer";
import type { Unsubscribe, WebContainerProcess } from "@webcontainer/api";

const STORAGE_KEY = "nexus-coding-chat";
const VOICE_STORAGE_KEY = "nexus-coding-voice-mode";
const MAX_FILE_SIZE = 500_000;
const MAX_FILES = 200;

type CodingTreeNode = {
  name: string;
  path: string;
  kind: "folder" | "file";
  children: CodingTreeNode[];
};

type CodingSurface = "assistant" | "editor";

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

type CodingStreamPart =
  | { type: "text" | "error"; value: string }
  | { type: "event"; value: CodingAgentEvent };

function parseCodingStreamLine(line: string): CodingStreamPart | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const separator = trimmed.indexOf(":");
  if (separator < 1) throw new Error("Nexus Code returned an invalid stream.");
  const code = trimmed.slice(0, separator);
  if (code === "2") {
    let parsedEvent: unknown;
    try {
      parsedEvent = JSON.parse(trimmed.slice(separator + 1)) as unknown;
    } catch {
      throw new Error("Nexus Code returned malformed agent event data.");
    }
    const event = CodingAgentEventSchema.safeParse(parsedEvent);
    if (!event.success) throw new Error("Nexus Code returned an invalid agent event.");
    return { type: "event", value: event.data };
  }
  if (code !== "0" && code !== "3") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(separator + 1)) as unknown;
  } catch {
    throw new Error("Nexus Code returned malformed stream data.");
  }
  if (typeof parsed !== "string") throw new Error("Nexus Code returned an invalid stream value.");
  return { type: code === "0" ? "text" : "error", value: parsed };
}

function buildCodingTree(files: CodingFile[]): CodingTreeNode[] {
  const root: CodingTreeNode[] = [];
  for (const file of files) {
    const segments = file.name.replaceAll("\\", "/").split("/").filter(Boolean);
    let level = root;
    let path = "";
    segments.forEach((segment, index) => {
      path = path ? `${path}/${segment}` : segment;
      const kind = index === segments.length - 1 ? "file" : "folder";
      let node = level.find((item) => item.name === segment && item.kind === kind);
      if (!node) {
        node = { name: segment, path, kind, children: [] };
        level.push(node);
      }
      level = node.children;
    });
  }

  const sortNodes = (nodes: CodingTreeNode[]): CodingTreeNode[] => nodes
    .sort((left, right) => (
      left.kind === right.kind
        ? left.name.localeCompare(right.name)
        : left.kind === "folder" ? -1 : 1
    ))
    .map((node) => ({ ...node, children: sortNodes(node.children) }));

  return sortNodes(root);
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
  const [workspaces, setWorkspaces] = useState<CodingWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Nexus Code Workspace");
  const [workspaceRevisionId, setWorkspaceRevisionId] = useState<string | null>(null);
  const [workspaceParentRevisionId, setWorkspaceParentRevisionId] = useState<string | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState("Loading workspace");
  const [input, setInput] = useState("");
  const [attachedFileNames, setAttachedFileNames] = useState<string[]>([]);
  const [mode, setMode] = useState<CodingMode>("ask");
  const [agent, setAgent] = useState<CodingAgent>("deepseek-chat");
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [codingSurface, setCodingSurface] = useState<CodingSurface>("assistant");
  const [showFiles, setShowFiles] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [previewUrlDraft, setPreviewUrlDraft] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [livePreview, setLivePreview] = useState<CodingPreview | null>(null);
  const [previewRuntime, setPreviewRuntime] = useState<"webcontainer" | "runner">("webcontainer");
  const [webContainerStatus, setWebContainerStatus] = useState<CodingWebContainerStatus>("stopped");
  const [webContainerLogs, setWebContainerLogs] = useState("");
  const [livePreviewCommand, setLivePreviewCommand] = useState("npm run dev");
  const [livePreviewPort, setLivePreviewPort] = useState("3000");
  const [livePreviewNetwork, setLivePreviewNetwork] = useState(true);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<CodingVoiceStatus>("off");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const voiceModeRef = useRef(false);
  const voiceRecognitionRef = useRef<CodingVoiceRecognition | null>(null);
  const voiceSessionRef = useRef(0);
  const voiceRestartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceResumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const voiceCommandRef = useRef("");
  const voiceInstructionRef = useRef("");
  const speechGenerationRef = useRef(0);
  const speechUnlockedRef = useRef(false);
  const workspaceReadyRef = useRef(false);
  const workspaceIdRef = useRef<string | null>(null);
  const workspaceRevisionRef = useRef<string | null>(null);
  const workspaceSyncedFilesRef = useRef("");
  const workspaceChangeReasonRef = useRef("Manual workspace edit");
  const workspaceChangeSourceRef = useRef<"user" | "agent" | "import">("user");
  const workspaceSaveQueueRef = useRef(Promise.resolve());
  const webContainerProcessRef = useRef<WebContainerProcess | null>(null);
  const webContainerUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const webContainerGenerationRef = useRef(0);
  const webContainerReadyRef = useRef(false);
  const webContainerSyncedFilesRef = useRef<Set<string>>(new Set());
  const webContainerSyncQueueRef = useRef(Promise.resolve());
  const fileTree = useMemo(() => buildCodingTree(files), [files]);
  const selectedFile = useMemo(
    () => files.find((file) => file.name === selectedFileName) ?? null,
    [files, selectedFileName],
  );
  const selectedFileIsHtml = selectedFile?.language === "html"
    || /\.(?:html?|xhtml)$/i.test(selectedFile?.name ?? "");
  const selectedFileCanPreview = Boolean(selectedFile && selectedFileIsHtml);

  useEffect(() => {
    if (selectedFileName && files.some((file) => file.name === selectedFileName)) return;
    setSelectedFileName(files[0]?.name ?? null);
  }, [files, selectedFileName]);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => () => {
    webContainerGenerationRef.current += 1;
    webContainerUnsubscribeRef.current?.();
    webContainerProcessRef.current?.kill();
    void teardownCodingWebContainer().catch((runtimeError: unknown) => {
      console.error("[coding] Failed to stop WebContainer", runtimeError);
    });
  }, []);

  const applyWorkspaceSnapshot = useCallback((snapshot: CodingWorkspaceSnapshot) => {
    workspaceReadyRef.current = false;
    workspaceIdRef.current = snapshot.workspace.id;
    workspaceRevisionRef.current = snapshot.workspace.currentRevisionId;
    workspaceSyncedFilesRef.current = JSON.stringify(snapshot.revision.files);
    setWorkspaceId(snapshot.workspace.id);
    setWorkspaceName(snapshot.workspace.name);
    setWorkspaceRevisionId(snapshot.workspace.currentRevisionId);
    setWorkspaceParentRevisionId(snapshot.revision.parentRevisionId);
    setSelectedFileName(snapshot.revision.files[0]?.name ?? null);
    setFiles(snapshot.revision.files);
    setLivePreview(null);
    setPreviewUrl("");
    workspaceReadyRef.current = true;
    setWorkspaceStatus("Saved");
  }, []);

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

  useEffect(() => {
    let active = true;
    const loadWorkspace = async () => {
      setWorkspaceStatus("Loading workspace");
      try {
        const listResponse = await fetch("/api/coding/workspaces", {
          cache: "no-store",
          credentials: "same-origin",
        });
        if (!listResponse.ok) {
          const payload = await listResponse.json().catch(() => null) as { error?: unknown } | null;
          throw new Error(typeof payload?.error === "string" ? payload.error : "Coding workspaces could not be loaded.");
        }
        const listPayload = await listResponse.json() as { workspaces?: unknown };
        const parsedList = CodingWorkspaceSchema.array().safeParse(listPayload.workspaces);
        if (!parsedList.success) throw new Error("Coding workspace list was invalid.");
        setWorkspaces(parsedList.data);
        const latest = parsedList.data[0];
        let response: Response;
        if (latest) {
          response = await fetch(`/api/coding/workspaces/${encodeURIComponent(latest.id)}`, {
            cache: "no-store",
            credentials: "same-origin",
          });
        } else {
          response = await fetch("/api/coding/workspaces", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "same-origin",
            body: JSON.stringify({ name: "Nexus Code Workspace", files: [] }),
          });
        }
        const payload = await response.json().catch(() => null) as unknown;
        if (!response.ok) {
          const errorPayload = payload as { error?: unknown } | null;
          throw new Error(typeof errorPayload?.error === "string" ? errorPayload.error : "Coding workspace could not be opened.");
        }
        const parsed = CodingWorkspaceSnapshotSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Coding workspace data was invalid.");
        if (!active) return;
        if (!latest) setWorkspaces((current) => [parsed.data.workspace, ...current]);
        applyWorkspaceSnapshot(parsed.data);
      } catch (workspaceError) {
        if (!active) return;
        workspaceReadyRef.current = false;
        setWorkspaceStatus("Needs attention");
        setError(workspaceError instanceof Error ? workspaceError.message : "Coding workspace could not be loaded.");
      }
    };
    void loadWorkspace();
    return () => {
      active = false;
      workspaceReadyRef.current = false;
    };
  }, [applyWorkspaceSnapshot]);

  const resetProjectConversation = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setInput("");
    setAttachedFileNames([]);
    setMessages([{ ...INITIAL_MESSAGE, createdAt: new Date().toISOString() }]);
    setCodingSurface("assistant");
    setShowFiles(false);
    setShowPreview(false);
    setPreviewExpanded(false);
    setPreviewUrl("");
    setPreviewUrlDraft("");
    setSelectedFileName(null);
  }, []);

  const openWorkspace = useCallback(async (nextWorkspaceId: string) => {
    if (!nextWorkspaceId || nextWorkspaceId === workspaceId || loading) return;
    await workspaceSaveQueueRef.current.catch(() => undefined);
    workspaceReadyRef.current = false;
    setWorkspaceStatus("Loading workspace");
    setError(null);
    try {
      const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(nextWorkspaceId)}`, {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = payload as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : "Coding workspace could not be opened.");
      }
      const parsed = CodingWorkspaceSnapshotSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Coding workspace data was invalid.");
      setWorkspaces((current) => current.map((workspace) => (
        workspace.id === parsed.data.workspace.id ? parsed.data.workspace : workspace
      )));
      applyWorkspaceSnapshot(parsed.data);
      resetProjectConversation();
    } catch (workspaceError) {
      workspaceReadyRef.current = false;
      setWorkspaceStatus("Needs attention");
      setError(workspaceError instanceof Error ? workspaceError.message : "Coding workspace could not be opened.");
    }
  }, [applyWorkspaceSnapshot, loading, resetProjectConversation, workspaceId]);

  const createWorkspace = useCallback(async () => {
    if (loading) return;
    const name = window.prompt("Name your new Nexus Code project", "Untitled Code Project")?.trim();
    if (!name) return;
    await workspaceSaveQueueRef.current.catch(() => undefined);
    workspaceReadyRef.current = false;
    setWorkspaceStatus("Creating project");
    setError(null);
    try {
      const response = await fetch("/api/coding/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name, files: [] }),
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = payload as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : "New coding project could not be created.");
      }
      const parsed = CodingWorkspaceSnapshotSchema.safeParse(payload);
      if (!parsed.success) throw new Error("New coding project data was invalid.");
      setWorkspaces((current) => [parsed.data.workspace, ...current.filter((workspace) => workspace.id !== parsed.data.workspace.id)]);
      applyWorkspaceSnapshot(parsed.data);
      resetProjectConversation();
      setStatus("Ready");
    } catch (workspaceError) {
      workspaceReadyRef.current = false;
      setWorkspaceStatus("Needs attention");
      setError(workspaceError instanceof Error ? workspaceError.message : "New coding project could not be created.");
    }
  }, [applyWorkspaceSnapshot, loading, resetProjectConversation]);

  const deleteWorkspace = useCallback(async () => {
    if (!workspaceId || loading) return;
    const projectName = workspaceName || "this project";
    if (!window.confirm(`Delete "${projectName}" permanently? All files and revisions will be removed.`)) return;
    await workspaceSaveQueueRef.current.catch(() => undefined);
    workspaceReadyRef.current = false;
    setWorkspaceStatus("Deleting project");
    setError(null);
    try {
      const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
      const payload = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "Project could not be deleted.");
      }
      const remaining = workspaces.filter((workspace) => workspace.id !== workspaceId);
      setWorkspaces(remaining);
      workspaceIdRef.current = null;
      if (remaining[0]) {
        setWorkspaceId(null);
        setFiles([]);
        setWorkspaceRevisionId(null);
        setWorkspaceParentRevisionId(null);
        resetProjectConversation();
        await openWorkspace(remaining[0].id);
      } else {
        setWorkspaceId(null);
        setWorkspaceName("No project");
        setWorkspaceRevisionId(null);
        setWorkspaceParentRevisionId(null);
        setFiles([]);
        resetProjectConversation();
        setWorkspaceStatus("No project");
        setStatus("Ready");
      }
    } catch (workspaceError) {
      workspaceReadyRef.current = true;
      setWorkspaceStatus("Needs attention");
      setError(workspaceError instanceof Error ? workspaceError.message : "Project could not be deleted.");
    }
  }, [loading, openWorkspace, resetProjectConversation, workspaceId, workspaceName, workspaces]);

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
    const spokenResponse = buildCodingSpokenResponse(content, voiceInstructionRef.current);
    const chunks = splitCodingVoiceText(spokenResponse);
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
      Math.min(120_000, Math.max(4_000, cleanCodingVoiceText(content).length * 65 + 2_000)),
    );
    speakNext();
  }, [finishVoiceSpeech, scheduleWakeRecognition, stopVoiceOutput]);

  function startWakeRecognition(): void {
    if (!voiceModeRef.current) return;
    clearVoiceRestartTimer();
    stopVoiceRecognition();
    const recognition = createCodingVoiceRecognition();
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
      const { isFinal, transcript } = getCodingRecognitionText(event);
      if (!isFinal) return;
      const command = extractCodingWakeCommand(transcript);
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
    const recognition = createCodingVoiceRecognition();
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
      const { transcript } = getCodingRecognitionText(event);
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
    if (isCodingGreeting(normalized)) {
      const greeting = buildCodingGreetingResponse(normalized);
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
    if (!createCodingVoiceRecognition()) {
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
  }, [codingSurface, loading, messages]);

  const clearConversation = useCallback(() => {
    abortRef.current?.abort();
    setLoading(false);
    setStatus("Ready");
    setError(null);
    setAttachedFileNames([]);
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

  const queueWorkspaceSave = useCallback((
    nextFiles: CodingFile[],
    reason: string,
    source: "user" | "agent" | "import",
  ) => {
    if (!workspaceId || !workspaceReadyRef.current) return;
    const targetWorkspaceId = workspaceId;
    const baseRevisionId = workspaceRevisionRef.current;
    if (!baseRevisionId) return;
    const operation = async () => {
      if (workspaceIdRef.current !== targetWorkspaceId) return;
      setWorkspaceStatus("Saving");
      try {
        const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(targetWorkspaceId)}/revisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            baseRevisionId,
            files: nextFiles,
            reason,
            source,
          }),
        });
        const payload = await response.json().catch(() => null) as unknown;
        if (response.status === 409) {
          const conflict = payload as { current?: unknown; error?: unknown } | null;
          const parsedCurrent = CodingWorkspaceSnapshotSchema.safeParse(conflict?.current);
          if (parsedCurrent.success && workspaceIdRef.current === targetWorkspaceId) {
            workspaceRevisionRef.current = parsedCurrent.data.workspace.currentRevisionId;
            workspaceSyncedFilesRef.current = JSON.stringify(parsedCurrent.data.revision.files);
            setWorkspaceRevisionId(parsedCurrent.data.workspace.currentRevisionId);
            setWorkspaceParentRevisionId(parsedCurrent.data.revision.parentRevisionId);
            setFiles(parsedCurrent.data.revision.files);
          }
          throw new Error(typeof conflict?.error === "string"
            ? conflict.error
            : "The coding workspace changed before your edit was saved.");
        }
        if (!response.ok) {
          const failure = payload as { error?: unknown } | null;
          throw new Error(typeof failure?.error === "string" ? failure.error : "Coding workspace could not be saved.");
        }
        const parsed = CodingWorkspaceSnapshotSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Coding workspace save response was invalid.");
        if (workspaceIdRef.current !== targetWorkspaceId) return;
        workspaceRevisionRef.current = parsed.data.workspace.currentRevisionId;
        workspaceSyncedFilesRef.current = JSON.stringify(parsed.data.revision.files);
        setWorkspaceRevisionId(parsed.data.workspace.currentRevisionId);
        setWorkspaceParentRevisionId(parsed.data.revision.parentRevisionId);
        setWorkspaces((current) => current.map((workspace) => (
          workspace.id === parsed.data.workspace.id ? parsed.data.workspace : workspace
        )));
        setWorkspaceStatus("Saved");
      } catch (saveError) {
        if (workspaceIdRef.current !== targetWorkspaceId) return;
        setWorkspaceStatus("Needs attention");
        setError(saveError instanceof Error ? saveError.message : "Coding workspace could not be saved.");
      }
    };
    workspaceSaveQueueRef.current = workspaceSaveQueueRef.current
      .catch(() => undefined)
      .then(operation);
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId || !workspaceReadyRef.current) return;
    const signature = JSON.stringify(files);
    if (signature === workspaceSyncedFilesRef.current) return;
    const timer = window.setTimeout(() => {
      queueWorkspaceSave(
        files,
        workspaceChangeReasonRef.current,
        workspaceChangeSourceRef.current,
      );
    }, 800);
    return () => window.clearTimeout(timer);
  }, [files, queueWorkspaceSave, workspaceId]);

  const addFiles = useCallback(async (selected: FileList | null, attachToChat = false) => {
    if (!selected) return;
    const incoming = Array.from(selected);
    if (files.length + incoming.length > MAX_FILES) {
      setError(`This workspace supports no more than ${MAX_FILES} source files.`);
      return;
    }
    const nextFiles: CodingFile[] = [];
    for (const file of incoming) {
      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name} is too large. Keep each source file under 500 KB.`);
        continue;
      }
      const fileName = file.webkitRelativePath || file.name;
      nextFiles.push({
        name: fileName,
        content: await file.text(),
        language: codingLanguageFromName(fileName),
      });
    }
    if (nextFiles.length > 0) {
      if (attachToChat) {
        setAttachedFileNames((current) => Array.from(new Set([
          ...current,
          ...nextFiles.map((file) => file.name),
        ])));
      }
      workspaceChangeReasonRef.current = "Imported source files";
      workspaceChangeSourceRef.current = "import";
      setFiles((current) => {
        const merged = new Map(current.map((file) => [file.name, file]));
        for (const file of nextFiles) merged.set(file.name, file);
        return Array.from(merged.values()).slice(0, MAX_FILES);
      });
      setSelectedFileName(nextFiles[0].name);
      setError(null);
    }
  }, [files.length]);

  const updateSelectedFile = useCallback((content: string) => {
    if (!selectedFileName) return;
    workspaceChangeReasonRef.current = `Edited ${selectedFileName}`;
    workspaceChangeSourceRef.current = "user";
    setFiles((current) => current.map((file) => (
      file.name === selectedFileName ? { ...file, content } : file
    )));
  }, [selectedFileName]);

  const syncGeneratedFiles = useCallback((content: string) => {
    const generatedFiles = extractCodingFiles(content);
    if (generatedFiles.length === 0) return;
    workspaceChangeReasonRef.current = "Nexus Code generated files";
    workspaceChangeSourceRef.current = "agent";
    setFiles((current) => {
      const merged = new Map(current.map((file) => [file.name, file]));
      let changed = false;
      for (const file of generatedFiles) {
        const previous = merged.get(file.name);
        if (!previous || previous.content !== file.content || previous.language !== file.language) {
          merged.set(file.name, file);
          changed = true;
        }
      }
      return changed ? Array.from(merged.values()).slice(0, MAX_FILES) : current;
    });
  }, []);

  const undoWorkspace = useCallback(async () => {
    if (!workspaceId || !workspaceParentRevisionId || loading) return;
    setWorkspaceStatus("Reverting");
    setError(null);
    try {
      const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/revert`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ revisionId: workspaceParentRevisionId }),
      });
      const payload = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        const failure = payload as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : "Workspace undo failed.");
      }
      const parsed = CodingWorkspaceSnapshotSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Workspace undo response was invalid.");
      workspaceRevisionRef.current = parsed.data.workspace.currentRevisionId;
      workspaceSyncedFilesRef.current = JSON.stringify(parsed.data.revision.files);
      workspaceChangeSourceRef.current = "user";
      setWorkspaceRevisionId(parsed.data.workspace.currentRevisionId);
      setWorkspaceParentRevisionId(parsed.data.revision.parentRevisionId);
      setFiles(parsed.data.revision.files);
      setWorkspaceStatus("Saved");
    } catch (undoError) {
      setWorkspaceStatus("Needs attention");
      setError(undoError instanceof Error ? undoError.message : "Workspace undo failed.");
    }
  }, [loading, workspaceId, workspaceParentRevisionId]);

  const openPreview = useCallback(() => {
    const candidate = previewUrlDraft.trim();
    if (!candidate) {
      if (selectedFileCanPreview) {
        setPreviewUrl("");
        setShowPreview(true);
        setError(null);
      } else {
        setError("Enter a running app URL or select an HTML file to preview.");
      }
      return;
    }
    try {
      const url = new URL(candidate);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("Only HTTP and HTTPS preview URLs are supported.");
      }
      setPreviewUrl(url.toString());
      setShowPreview(true);
      setError(null);
    } catch (previewError) {
      setError(previewError instanceof Error ? previewError.message : "Enter a valid app preview URL.");
    }
  }, [previewUrlDraft, selectedFileCanPreview]);

  const downloadPreviewHtml = useCallback(() => {
    if (!selectedFile || !selectedFileCanPreview || previewUrl) {
      setError("Download is available when a local HTML file is shown in the preview.");
      return;
    }
    const fileName = selectedFile.name.split("/").pop() || "preview.html";
    const downloadName = /\.(?:html?|xhtml?)$/i.test(fileName) ? fileName : `${fileName}.html`;
    const objectUrl = URL.createObjectURL(new Blob([selectedFile.content], {
      type: "text/html;charset=utf-8",
    }));
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = downloadName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  }, [previewUrl, selectedFile, selectedFileCanPreview]);

  const stopWebContainerPreview = useCallback(async () => {
    webContainerGenerationRef.current += 1;
    webContainerUnsubscribeRef.current?.();
    webContainerUnsubscribeRef.current = null;
    webContainerProcessRef.current?.kill();
    webContainerProcessRef.current = null;
    webContainerReadyRef.current = false;
    webContainerSyncedFilesRef.current.clear();
    try {
      await teardownCodingWebContainer();
    } catch (runtimeError) {
      setError(runtimeError instanceof Error ? runtimeError.message : "The WebContainer could not be stopped.");
    }
    setWebContainerStatus(CodingWebContainerStatusSchema.parse("stopped"));
    setPreviewUrl("");
    setWorkspaceStatus("Saved");
  }, []);

  const startWebContainerPreview = useCallback(async () => {
    if (!workspaceId || !workspaceRevisionId) {
      setError("Save or create a coding project before starting a live preview.");
      return;
    }
    const parsedCommand = CodingWebContainerCommandSchema.safeParse(livePreviewCommand);
    if (!parsedCommand.success) {
      setError("Enter a command between 1 and 500 characters.");
      return;
    }
    const command = parsedCommand.data;
    setError(null);
    await workspaceSaveQueueRef.current;
    await stopWebContainerPreview();
    const generation = ++webContainerGenerationRef.current;
    webContainerReadyRef.current = false;
    setWebContainerLogs("");
    setWebContainerStatus(CodingWebContainerStatusSchema.parse("starting"));
    setWorkspaceStatus("Starting WebContainer");
    setPreviewUrl("");
    setShowPreview(true);

    const consumeOutput = (process: WebContainerProcess) => {
      void process.output.pipeTo(new WritableStream<string>({
        write(chunk) {
          const parsedOutput = CodingWebContainerOutputSchema.safeParse(chunk);
          if (!parsedOutput.success) throw new Error("The WebContainer returned invalid terminal output.");
          if (generation !== webContainerGenerationRef.current) return;
          setWebContainerLogs((current) => `${current}${parsedOutput.data}`.slice(-12_000));
        },
      })).catch((outputError: unknown) => {
        if (generation === webContainerGenerationRef.current) {
          setError(outputError instanceof Error ? outputError.message : "WebContainer terminal output failed.");
        }
      });
    };

    try {
      if (!window.crossOriginIsolated) {
        throw new Error("WebContainers need cross-origin isolation. Reload Nexus Code after enabling its COOP/COEP response headers.");
      }
      const runtime = await bootCodingWebContainer();
      if (generation !== webContainerGenerationRef.current) return;
      await runtime.mount(createCodingWebContainerFileTree(files));
      webContainerSyncedFilesRef.current = new Set(files.map((file) => file.name));
      if (generation !== webContainerGenerationRef.current) return;

      if (files.some((file) => file.name === "package.json")) {
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("installing"));
        setWorkspaceStatus("Installing project dependencies");
        const installProcess = await runtime.spawn("npm", ["install"]);
        webContainerProcessRef.current = installProcess;
        consumeOutput(installProcess);
        const installExitCode = await installProcess.exit;
        webContainerProcessRef.current = null;
        if (installExitCode !== 0) throw new Error(`Dependency installation failed with exit code ${installExitCode}.`);
      }
      if (generation !== webContainerGenerationRef.current) return;

      const readyUnsubscribe = runtime.on("server-ready", (port, url) => {
        const parsed = CodingWebContainerReadySchema.safeParse({ port, url });
        if (!parsed.success) {
          setError("The WebContainer announced an invalid preview address.");
          return;
        }
        if (generation !== webContainerGenerationRef.current) return;
        webContainerReadyRef.current = true;
        setPreviewUrl(parsed.data.url);
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("running"));
        setWorkspaceStatus(`App running on port ${parsed.data.port}`);
      });
      const errorUnsubscribe = runtime.on("error", (runtimeError) => {
        if (generation !== webContainerGenerationRef.current) return;
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("failed"));
        setError(runtimeError.message || "The WebContainer runtime failed.");
      });
      webContainerUnsubscribeRef.current = () => {
        readyUnsubscribe();
        errorUnsubscribe();
      };

      const [executable, ...args] = command.split(/\s+/);
      if (!executable) throw new Error("Enter a command to start the app.");
      const process = await runtime.spawn(executable, args);
      webContainerProcessRef.current = process;
      consumeOutput(process);
      void process.exit.then((exitCode) => {
        if (generation !== webContainerGenerationRef.current) return;
        webContainerProcessRef.current = null;
        if (exitCode !== 0 || !webContainerReadyRef.current) {
          setWebContainerStatus(CodingWebContainerStatusSchema.parse("failed"));
          setWorkspaceStatus("WebContainer app stopped");
          setError(`The app command exited with code ${exitCode} before a preview was ready.`);
        }
      }).catch((processError: unknown) => {
        if (generation !== webContainerGenerationRef.current) return;
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("failed"));
        setError(processError instanceof Error ? processError.message : "The app command failed.");
      });
    } catch (previewError) {
      if (generation !== webContainerGenerationRef.current) return;
      setWebContainerStatus(CodingWebContainerStatusSchema.parse("failed"));
      setWorkspaceStatus("WebContainer failed");
      setError(previewError instanceof Error ? previewError.message : "WebContainer preview could not start.");
    }
  }, [files, livePreviewCommand, stopWebContainerPreview, workspaceId, workspaceRevisionId]);

  useEffect(() => {
    if (webContainerStatus !== "running") return;
    let cancelled = false;
    const nextFileNames = new Set(files.map((file) => file.name));
    webContainerSyncQueueRef.current = webContainerSyncQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        const tree = createCodingWebContainerFileTree(files);
        const runtime = await bootCodingWebContainer();
        if (cancelled) return;
        for (const oldFileName of webContainerSyncedFilesRef.current) {
          if (!nextFileNames.has(oldFileName)) {
            await runtime.fs.rm(oldFileName, { force: true, recursive: true });
          }
        }
        await runtime.mount(tree);
        if (!cancelled) webContainerSyncedFilesRef.current = nextFileNames;
      })
      .catch((syncError: unknown) => {
        if (!cancelled) {
          setError(syncError instanceof Error ? syncError.message : "Coding files could not be synced to the WebContainer.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [files, webContainerStatus]);

  const startLivePreview = useCallback(async () => {
    if (previewRuntime === "webcontainer") {
      try {
        if (workspaceId && livePreview) {
          const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(livePreview.id)}`, {
            method: "DELETE",
            credentials: "same-origin",
          });
          if (!response.ok) throw new Error("The previous isolated preview could not be stopped.");
          setLivePreview(null);
        }
        await startWebContainerPreview();
      } catch (previewError) {
        setError(previewError instanceof Error ? previewError.message : "WebContainer preview could not start.");
      }
      return;
    }
    await stopWebContainerPreview();
    if (!workspaceId || !workspaceRevisionId) {
      setError("Save or create a coding project before starting a live preview.");
      return;
    }
    const command = livePreviewCommand.trim();
    const port = Number.parseInt(livePreviewPort, 10);
    if (!command || !Number.isInteger(port) || port < 1024 || port > 65535) {
      setError("Enter a valid preview command and port between 1024 and 65535.");
      return;
    }
    setError(null);
    setWorkspaceStatus("Starting live preview");
    try {
      if (livePreview) {
        await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(livePreview.id)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
      }
      const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          revisionId: workspaceRevisionId,
          command,
          port,
          network: livePreviewNetwork,
        }),
      });
      const payload = await response.json().catch(() => null) as { preview?: unknown; error?: unknown } | null;
      if (!response.ok) {
        throw new Error(typeof payload?.error === "string" ? payload.error : "Live preview could not start.");
      }
      const parsed = CodingPreviewSchema.safeParse(payload?.preview);
      if (!parsed.success) throw new Error("Live preview returned an invalid response.");
      setLivePreview(parsed.data);
      setPreviewUrl("");
      setShowPreview(true);
      setWorkspaceStatus("Live preview starting");
    } catch (previewError) {
      setWorkspaceStatus("Needs attention");
      setError(previewError instanceof Error ? previewError.message : "Live preview could not start.");
    }
  }, [
    livePreview,
    livePreviewCommand,
    livePreviewNetwork,
    livePreviewPort,
    previewRuntime,
    startWebContainerPreview,
    stopWebContainerPreview,
    workspaceId,
    workspaceRevisionId,
  ]);

  const stopLivePreview = useCallback(async () => {
    if (!workspaceId || !livePreview) return;
    try {
      await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(livePreview.id)}`, {
        method: "DELETE",
        credentials: "same-origin",
      });
    } finally {
      setLivePreview(null);
      setPreviewUrl("");
      setWorkspaceStatus("Saved");
    }
  }, [livePreview, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !livePreview || livePreview.status === "running" || livePreview.status === "failed" || livePreview.status === "stopped") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(livePreview.id)}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        const payload = await response.json().catch(() => null) as { preview?: unknown; error?: unknown } | null;
        if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "Live preview status failed.");
        const parsed = CodingPreviewSchema.safeParse(payload?.preview);
        if (!parsed.success) throw new Error("Live preview status was invalid.");
        if (cancelled) return;
        setLivePreview(parsed.data);
        if (parsed.data.status === "running" && parsed.data.previewUrl) {
          setPreviewUrl(parsed.data.previewUrl);
          setWorkspaceStatus("Live preview ready");
        } else if (parsed.data.status === "failed") {
          setWorkspaceStatus("Live preview failed");
          setError("The live preview container failed to start.");
        }
      } catch (pollError) {
        if (!cancelled) setError(pollError instanceof Error ? pollError.message : "Live preview status failed.");
      }
    };
    const timer = window.setInterval(() => void poll(), 1500);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [livePreview, workspaceId]);

  const toggleWorkspacePanel = useCallback((panel: "files" | "preview") => {
    const isMobile = window.matchMedia("(max-width: 1023px)").matches;
    if (panel === "files") {
      setShowFiles((current) => {
        const next = !current;
        if (isMobile && next) setShowPreview(false);
        return next;
      });
      return;
    }
    setShowPreview((current) => {
      const next = !current;
      if (isMobile && next) setShowFiles(false);
      return next;
    });
  }, []);

  const send = useCallback(async (requestedQuery?: string) => {
    const query = (requestedQuery ?? input).trim();
    if (!query || loading) return;
    voiceInstructionRef.current = query;
    workspaceChangeReasonRef.current = `Nexus Code: ${query.slice(0, 360)}`;
    workspaceChangeSourceRef.current = "agent";
    setLoading(true);
    setStatus("Nexus Code is working");
    setError(null);
    const userMessage: CodingStoredMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: query,
      createdAt: new Date().toISOString(),
      fileNames: attachedFileNames,
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
        credentials: "same-origin",
        body: JSON.stringify({
          query,
          mode,
          agent,
          workspaceId: workspaceId ?? undefined,
          revisionId: workspaceRevisionRef.current ?? undefined,
          history: requestHistory,
          files,
        }),
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
      let streamBuffer = "";
      let streamError: string | null = null;
      const appendStreamPart = (part: CodingStreamPart | null) => {
        if (!part) return;
        if (part.type === "error") {
          streamError = part.value;
          return;
        }
        if (part.type === "event") {
          const event = part.value;
          if (event.type === "files.proposed") {
            workspaceChangeReasonRef.current = event.reason;
            workspaceChangeSourceRef.current = "agent";
            setFiles((current) => {
              const merged = new Map(current.map((file) => [file.name, file]));
              for (const file of event.files) merged.set(file.name, file);
              return Array.from(merged.values()).slice(0, MAX_FILES);
            });
          }
          if (event.type === "run.failed") setError(event.message);
          return;
        }
        content += part.value;
      };
      const consumeStreamChunk = (chunk: string) => {
        streamBuffer += chunk;
        const lines = streamBuffer.split("\n");
        streamBuffer = lines.pop() ?? "";
        for (const line of lines) appendStreamPart(parseCodingStreamLine(line));
      };
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        consumeStreamChunk(decoder.decode(result.value, { stream: true }));
        if (content) {
          setMessages((current) => current.map((message) => (
            message.id === assistantId ? { ...message, content } : message
          )));
          syncGeneratedFiles(content);
        }
      }
      consumeStreamChunk(decoder.decode());
      if (streamBuffer) appendStreamPart(parseCodingStreamLine(streamBuffer));
      if (streamError) throw new Error(streamError);
      if (!content) throw new Error("Nexus Code returned an empty response.");
      setMessages((current) => current.map((message) => (
        message.id === assistantId ? { ...message, content } : message
      )));
      syncGeneratedFiles(content);
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
  }, [agent, attachedFileNames, files, input, loading, messages, mode, speakAssistantResponse, syncGeneratedFiles, workspaceId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const renderTreeNodes = (nodes: CodingTreeNode[], depth = 0): React.ReactNode[] => nodes.flatMap((node) => {
    const row = node.kind === "file" ? (
      <button
        key={node.path}
        type="button"
        onClick={() => {
          setSelectedFileName(node.path);
          setCodingSurface("editor");
          setShowFiles(false);
          setShowPreview(false);
        }}
        className={`flex min-h-12 w-full items-center gap-2 rounded-lg px-2 text-left text-xs ${selectedFileName === node.path ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"}`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
      >
        <span className="shrink-0 font-mono text-[10px] text-cyan-400">{node.name.includes(".") ? "{" : "·"}</span>
        <span className="min-w-0 truncate">{node.name}</span>
      </button>
    ) : (
      <div key={node.path}>
        <div
          className="flex min-h-10 items-center gap-2 px-2 text-[10px] font-bold uppercase tracking-widest text-slate-500"
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span className="text-amber-300">▾</span>
          <span className="truncate">{node.name}</span>
        </div>
        {renderTreeNodes(node.children, depth + 1)}
      </div>
    );
    return [row];
  });

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-950/70 shadow-panel" aria-label="Nexus Code workspace">
      <header className="shrink-0 border-b border-cyan-500/20 bg-slate-950/80 px-3 py-3 backdrop-blur sm:px-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-cyan-400">Dedicated coding pipeline</p>
            <h1 className="mt-1 truncate text-base font-bold text-slate-100 sm:text-lg">Nexus Code</h1>
            <div className="mt-2 flex max-w-full items-center gap-2">
              <select
                value={workspaceId ?? ""}
                onChange={(event) => void openWorkspace(event.target.value)}
                disabled={loading || workspaces.length === 0}
                aria-label="Select coding project"
                className="min-h-12 min-w-0 max-w-[min(60vw,22rem)] flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200 focus:border-cyan-400/60 focus:outline-none disabled:opacity-60"
              >
                {!workspaceId && <option value="">{workspaceName}</option>}
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>{workspace.name}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void createWorkspace()}
                disabled={loading}
                className="min-h-12 shrink-0 rounded-xl border border-cyan-400/40 px-3 text-xs font-semibold text-cyan-200 disabled:opacity-40"
              >
                New project
              </button>
              <button
                type="button"
                onClick={() => void deleteWorkspace()}
                disabled={loading || !workspaceId}
                className="min-h-12 shrink-0 rounded-xl border border-rose-400/40 px-3 text-xs font-semibold text-rose-200 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <div className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold ${loading ? "border-amber-400/40 text-amber-300" : "border-emerald-400/30 text-emerald-300"}`}>
              {status}
            </div>
            <button
              type="button"
              onClick={() => void undoWorkspace()}
              disabled={!workspaceParentRevisionId || loading || !workspaceRevisionId}
              className="min-h-12 rounded-xl border border-slate-700 px-2 text-xs font-semibold text-slate-400 disabled:opacity-40"
            >
              Undo
            </button>
            <button type="button" onClick={clearConversation} className="min-h-12 rounded-xl px-2 text-xs font-semibold text-slate-500 hover:bg-slate-800 hover:text-slate-200">
              Clear
            </button>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <div className="flex min-h-12 items-center rounded-xl border border-slate-800 px-3 text-[10px] font-semibold text-slate-500" aria-live="polite">
            {workspaceStatus}
          </div>
          <button
            type="button"
            onClick={() => toggleWorkspacePanel("files")}
            aria-pressed={showFiles}
            className={`min-h-12 rounded-xl border px-3 text-xs font-semibold ${showFiles ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200" : "border-slate-700 text-slate-400"}`}
          >
            Explorer {files.length > 0 ? `(${files.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => toggleWorkspacePanel("preview")}
            aria-pressed={showPreview}
            className={`min-h-12 rounded-xl border px-3 text-xs font-semibold ${showPreview ? "border-violet-400/50 bg-violet-500/15 text-violet-200" : "border-slate-700 text-slate-400"}`}
          >
            Preview
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <aside className={`${showFiles ? "flex" : "hidden"} w-full shrink-0 flex-col border-b border-cyan-500/20 bg-slate-950/80 lg:w-64 lg:border-b-0 lg:border-r`} aria-label="Project file tree">
          <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-800 px-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-cyan-400">Workspace</p>
              <p className="mt-1 text-xs font-semibold text-slate-200">Project files</p>
            </div>
            <button type="button" onClick={() => setShowFiles(false)} className="min-h-12 min-w-12 rounded-xl text-xs text-slate-500" aria-label="Close file tree">
              ×
            </button>
          </div>
          <div className="flex shrink-0 gap-2 border-b border-slate-800 p-3">
            <input
              ref={folderInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                void addFiles(event.target.files, false);
                event.target.value = "";
              }}
            />
            <button type="button" onClick={() => folderInputRef.current?.click()} className="min-h-12 w-full rounded-xl bg-cyan-400 px-3 text-xs font-bold text-slate-950">
              Open folder
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" style={{ WebkitOverflowScrolling: "touch" }}>
            {fileTree.length > 0 ? renderTreeNodes(fileTree) : (
              <div className="rounded-xl border border-dashed border-slate-700 p-4 text-xs leading-5 text-slate-500">
                Open a folder, attach files, or let Nexus Code generate components to build the tree.
              </div>
            )}
          </div>
        </aside>

        <div className={`${showFiles || showPreview ? "hidden lg:flex" : "flex"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden`}>
          <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-slate-800 px-3">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <button
                type="button"
                onClick={() => setCodingSurface("assistant")}
                className={`min-h-12 shrink-0 rounded-lg px-3 text-xs font-semibold ${codingSurface === "assistant" ? "bg-cyan-500/15 text-cyan-200" : "text-slate-500"}`}
              >
                Assistant
              </button>
              {selectedFile && (
                <button
                  type="button"
                  onClick={() => setCodingSurface("editor")}
                  className={`min-h-12 max-w-52 shrink-0 truncate rounded-lg px-3 text-xs font-semibold ${codingSurface === "editor" ? "bg-violet-500/15 text-violet-200" : "text-slate-500"}`}
                >
                  {selectedFile.name}
                </button>
              )}
            </div>
            {codingSurface === "editor" && selectedFileCanPreview && (
              <button
                type="button"
                onClick={() => { setPreviewUrl(""); setShowPreview(true); }}
                className="min-h-12 shrink-0 rounded-lg px-3 text-xs font-semibold text-violet-200"
              >
                Preview
              </button>
            )}
          </div>

          {codingSurface === "assistant" ? (
            <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 lg:px-8" style={{ WebkitOverflowScrolling: "touch" }}>
              <div className={`mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4 ${messages.length === 1 ? "justify-center" : "justify-end"}`}>
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
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950/60">
              {selectedFile ? (
                <>
                  <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4">
                    <span className="truncate font-mono text-xs text-slate-400">{selectedFile.name}</span>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-slate-600">{selectedFile.language ?? "text"}</span>
                  </div>
                  <textarea
                    value={selectedFile.content}
                    onChange={(event) => updateSelectedFile(event.target.value)}
                    aria-label={`Edit ${selectedFile.name}`}
                    spellCheck={false}
                    className="min-h-0 flex-1 resize-none bg-transparent px-4 py-4 font-mono text-base leading-6 text-slate-300 focus:outline-none"
                  />
                </>
              ) : (
                <div className="flex min-h-[320px] flex-1 items-center justify-center px-6 text-center">
                  <p className="max-w-sm text-sm leading-6 text-slate-500">Choose a file from the project explorer to open it in the editor.</p>
                </div>
              )}
            </div>
          )}

          <div className="shrink-0 border-t border-cyan-500/20 bg-slate-950/95 p-3 sm:p-4" style={{ paddingBottom: "max(env(safe-area-inset-bottom), 0.75rem)" }}>
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
              void addFiles(event.target.files, true);
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
          {attachedFileNames.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-slate-800 px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {attachedFileNames.map((fileName) => (
                <button key={fileName} type="button" onClick={() => setAttachedFileNames((current) => current.filter((name) => name !== fileName))} className="min-h-12 max-w-48 shrink-0 truncate rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 text-xs text-cyan-200">
                  {fileName} ×
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
        </div>

        <aside className={previewExpanded
          ? `${showPreview ? "flex" : "hidden"} fixed inset-0 z-50 h-dvh w-full flex-col border border-cyan-500/30 bg-slate-950`
          : `${showPreview ? "flex" : "hidden"} w-full shrink-0 flex-col border-t border-cyan-500/20 bg-slate-950/80 lg:w-[min(34vw,28rem)] lg:border-l lg:border-t-0`} aria-label="Application preview">
          <div className="flex min-h-14 shrink-0 items-center justify-between border-b border-slate-800 px-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-violet-300">Preview</p>
              <p className="mt-1 text-xs font-semibold text-slate-200">View your app</p>
            </div>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setPreviewExpanded((current) => !current)}
                className="min-h-12 min-w-12 rounded-xl border border-slate-700 px-2 text-xs font-semibold text-slate-300"
                aria-label={previewExpanded ? "Exit full-screen preview" : "Expand preview to full screen"}
              >
                {previewExpanded ? "Exit" : "Expand"}
              </button>
              <button type="button" onClick={() => { setShowPreview(false); setPreviewExpanded(false); }} className="min-h-12 min-w-12 rounded-xl text-xs text-slate-500" aria-label="Close app preview">
                ×
              </button>
            </div>
          </div>
          <div className="shrink-0 space-y-2 border-b border-slate-800 p-3">
            <div className="flex gap-2">
              <input
                value={previewUrlDraft}
                onChange={(event) => setPreviewUrlDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    openPreview();
                  }
                }}
                placeholder="https://your-app-preview..."
                aria-label="Running app preview URL"
                className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 py-3 text-base text-slate-200 placeholder:text-slate-600 focus:border-violet-400/60 focus:outline-none"
              />
              <button type="button" onClick={openPreview} className="min-h-12 min-w-12 rounded-xl bg-violet-400 px-3 text-xs font-bold text-slate-950" aria-label="Open app preview">
                Open
              </button>
            </div>
            <div className="rounded-xl border border-violet-500/20 bg-violet-500/5 p-2">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-violet-200">Temporary live preview</p>
                  <p className="mt-1 text-[10px] leading-4 text-slate-500">
                    {previewRuntime === "webcontainer"
                      ? "Runs this project in a StackBlitz WebContainer in your browser."
                      : "Runs the current revision in the isolated runner."}
                  </p>
                </div>
                <label className="flex min-h-12 shrink-0 items-center gap-2 text-[10px] text-slate-400">
                  Runtime
                  <select
                    value={previewRuntime}
                    onChange={(event) => setPreviewRuntime(CodingPreviewRuntimeSchema.parse(event.target.value))}
                    aria-label="Preview runtime"
                    className="min-h-12 rounded-lg border border-slate-700 bg-slate-900 px-2 text-base text-slate-200"
                  >
                    <option value="webcontainer">WebContainer</option>
                    <option value="runner">Isolated runner</option>
                  </select>
                </label>
              </div>
              <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                <input
                  value={livePreviewCommand}
                  onChange={(event) => setLivePreviewCommand(event.target.value)}
                  aria-label="Live preview command"
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-base text-slate-200 focus:border-violet-400/60 focus:outline-none"
                  placeholder="npm run dev"
                />
                {previewRuntime === "runner" && (
                  <>
                    <input
                      value={livePreviewPort}
                      onChange={(event) => setLivePreviewPort(event.target.value)}
                      inputMode="numeric"
                      aria-label="Live preview port"
                      className="min-h-12 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-base text-slate-200 sm:w-24"
                      placeholder="3000"
                    />
                    <label className="flex min-h-12 shrink-0 items-center gap-2 px-1 text-[10px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={livePreviewNetwork}
                        onChange={(event) => setLivePreviewNetwork(event.target.checked)}
                        className="h-5 w-5 accent-violet-400"
                      />
                      Network
                    </label>
                  </>
                )}
                {(previewRuntime === "webcontainer"
                  ? webContainerStatus === "starting" || webContainerStatus === "installing" || webContainerStatus === "running"
                  : Boolean(livePreview && livePreview.status !== "stopped" && livePreview.status !== "failed")) ? (
                  <button
                    type="button"
                    onClick={() => void (previewRuntime === "webcontainer" ? stopWebContainerPreview() : stopLivePreview())}
                    className="min-h-12 rounded-lg border border-rose-400/40 px-3 text-xs font-semibold text-rose-200"
                  >
                    Stop
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void startLivePreview()}
                    className="min-h-12 rounded-lg bg-violet-400 px-3 text-xs font-bold text-slate-950"
                  >
                    Start
                  </button>
                )}
              </div>
              {previewRuntime === "webcontainer" && webContainerStatus !== "stopped" && (
                <>
                  <p className="mt-2 text-[10px] text-violet-300" aria-live="polite">
                    {webContainerStatus === "installing" ? "Installing dependencies..." : `WebContainer ${webContainerStatus}.`}
                  </p>
                  {webContainerLogs && (
                    <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-slate-950 p-2 text-[10px] leading-4 text-slate-400">{webContainerLogs}</pre>
                  )}
                </>
              )}
              {previewRuntime === "runner" && livePreview && (
                <p className="mt-2 text-[10px] text-violet-300" aria-live="polite">
                  {livePreview.status === "starting" ? "Starting container..." : livePreview.status === "running" ? "Preview is live." : `Preview ${livePreview.status}.`}
                </p>
              )}
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] text-slate-600">Responsive preview</span>
              <div className="flex items-center gap-2">
                {selectedFileCanPreview && !previewUrl && (
                  <button type="button" onClick={downloadPreviewHtml} className="min-h-12 rounded-xl border border-cyan-500/30 px-3 text-xs font-semibold text-cyan-200">
                    Download HTML
                  </button>
                )}
                {previewUrl && (
                  <button type="button" onClick={() => window.open(previewUrl, "_blank", "noopener,noreferrer")} className="min-h-12 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300">
                    New tab
                  </button>
                )}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3" style={{ WebkitOverflowScrolling: "touch" }}>
            {previewUrl || selectedFileCanPreview ? (
              <div className={`mx-auto flex min-h-0 w-full overflow-hidden rounded-2xl border border-slate-700 bg-white shadow-2xl ${previewExpanded ? "h-full flex-1 flex-col" : ""}`}>
                <div className="flex h-8 items-center gap-1 border-b border-slate-300 bg-slate-100 px-3">
                  <span className="h-2 w-2 rounded-full bg-rose-400" />
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  <span className="ml-2 min-w-0 flex-1 truncate text-[9px] text-slate-500">{previewUrl || selectedFile?.name}</span>
                </div>
                <iframe
                  key={`${previewUrl}:${selectedFileName}:${selectedFile?.content.length ?? 0}`}
                  src={previewUrl || undefined}
                  srcDoc={previewUrl ? undefined : selectedFile?.content}
                  title="Nexus Code application preview"
                  sandbox="allow-forms allow-modals allow-popups allow-presentation allow-scripts"
                  className={previewExpanded
                    ? "block min-h-0 flex-1 w-full bg-white"
                    : "block h-[60dvh] min-h-[360px] max-h-[720px] w-full bg-white"}
                />
              </div>
            ) : (
              <div className="flex min-h-[320px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700 px-5 text-center">
                <p className="text-sm font-semibold text-slate-300">No app preview loaded</p>
                <p className="mt-2 max-w-xs text-xs leading-5 text-slate-500">
                  Select an HTML file for a local preview, or paste the URL of your running app above.
                </p>
              </div>
            )}
          </div>
        </aside>
      </div>
    </section>
  );
}
