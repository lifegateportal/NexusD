"use client";

import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { pickVoice } from "@/lib/audio-player-context";
import {
  CodingAgentSchema,
  CodingContextScopeHeaderSchema,
  CodingChatImageSchema,
  CodingModeSchema,
  CODING_PARTIAL_RESPONSE_MARKER,
  CODING_IMAGE_MEDIA_TYPES,
  MAX_CODING_HISTORY_MESSAGE_CHARACTERS,
  MAX_CODING_IMAGE_BYTES,
  MAX_CODING_IMAGES,
  MAX_CODING_IMAGES_BASE64_CHARACTERS,
  CODING_MODE_LABELS,
  type CodingAgent,
  type CodingChatImage,
  type CodingChatThread,
  type CodingFile,
  type CodingMode,
  type CodingStoredMessage,
} from "@/lib/coding-chat";
import {
  codingChatThreadTitle,
  createCodingChatThread,
  deleteCodingChatHistory,
  loadCodingChatHistory,
  saveCodingChatHistory,
} from "@/lib/coding-chat-history";
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
  CodingWorkspaceFileSchema,
  codingLanguageFromName,
  codingWorkspaceByteCount,
  extractCodingFiles,
  normalizeCodingFilePath,
  type CodingAgentEvent,
  type CodingPreview,
  type CodingWorkspace,
  type CodingWorkspaceFile,
  type CodingWorkspaceSnapshot,
} from "@/lib/coding-workspace";
import {
  CodingDeploymentKindSchema,
  CodingDeploymentListResponseSchema,
  CodingDeploymentResponseSchema,
  parseCodingDeploymentEnvironmentText,
  type CodingDeploymentKind,
  type CodingDeployment,
} from "@/lib/coding-deployment";
import { buildCodingStaticArtifact } from "@/lib/coding-static-build";
import {
  CodingGitHubPublishResponseSchema,
  CodingGitHubRepositoriesResponseSchema,
} from "@/lib/coding-github-schema";
import { createCodingWorkspaceZip, readCodingWorkspaceZip } from "@/lib/coding-zip";
import {
  deleteCodingLocalEnvironment,
  loadCodingLocalEnvironment,
  saveCodingLocalEnvironment,
} from "@/lib/coding-local-env";
import {
  bootCodingWebContainer,
  CodingWebContainerCommandSchema,
  CodingPreviewRuntimeSchema,
  CodingWebContainerOutputSchema,
  CodingWebContainerReadySchema,
  CodingWebContainerStatusSchema,
  createCodingWebContainerFileTree,
  teardownCodingWebContainer,
  withCodingWebContainerTimeout,
  type CodingWebContainerStatus,
} from "@/lib/coding-webcontainer";
import type { Unsubscribe, WebContainer, WebContainerProcess } from "@webcontainer/api";

const MARKDOWN_HEADING_TAGS: Record<number, "h1" | "h2" | "h3" | "h4" | "h5" | "h6"> = {
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
  5: "h5",
  6: "h6",
};

const VOICE_STORAGE_KEY = "nexus-coding-voice-mode";
const MAX_FILE_SIZE = 500_000;
const MAX_FILES = 200;
const MAX_WORKSPACE_BYTES = 4_000_000;
const LOCAL_ENV_FILE_NAME = ".env.local";

function encodeImageBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return window.btoa(binary);
}

function isPrivateEnvironmentFile(name: string): boolean {
  const baseName = name.replaceAll("\\", "/").split("/").at(-1) ?? name;
  return /^\.env(?:$|\.)/i.test(baseName) && baseName !== ".env.example";
}

function ensureLocalEnvironmentGitignore(files: CodingFile[]): CodingFile[] {
  const gitignoreIndex = files.findIndex((file) => file.name === ".gitignore");
  const existing = gitignoreIndex >= 0 ? files[gitignoreIndex] : null;
  if (existing?.content.split(/\r?\n/).some((line) => line.trim() === LOCAL_ENV_FILE_NAME)) {
    return files;
  }

  const content = existing
    ? `${existing.content}${existing.content && !existing.content.endsWith("\n") ? "\n" : ""}${LOCAL_ENV_FILE_NAME}\n`
    : `${LOCAL_ENV_FILE_NAME}\n`;
  const parsed = CodingWorkspaceFileSchema.safeParse({
    name: ".gitignore",
    content,
    language: "text",
  });
  if (!parsed.success) return files;

  const updated = [...files];
  if (gitignoreIndex >= 0) updated[gitignoreIndex] = parsed.data;
  else {
    if (files.length >= MAX_FILES) return files;
    updated.push(parsed.data);
  }
  if (codingWorkspaceByteCount(updated) > MAX_WORKSPACE_BYTES) return files;
  return updated;
}

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

function renderInlineMarkdown(content: string, keyPrefix: string): React.ReactNode[] {
  const pattern = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(__[^_\n]+?__)|(~~[^~\n]+?~~)|(?<!\w)\*([^*\n]+?)\*(?!\w)|(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  const rendered: React.ReactNode[] = [];
  let cursor = 0;
  let index = 0;
  for (const match of content.matchAll(pattern)) {
    const token = match[0];
    const start = match.index ?? 0;
    if (start > cursor) rendered.push(content.slice(cursor, start));

    const key = `${keyPrefix}-${index}`;
    const [, code, boldAsterisk, boldUnderscore, strike, italic, , linkLabel, linkUrl] = match;
    if (code) {
      rendered.push(<code key={key} className="rounded bg-slate-950 px-1 py-0.5 font-mono text-cyan-200">{code.slice(1, -1)}</code>);
    } else if (boldAsterisk || boldUnderscore) {
      const value = (boldAsterisk ?? boldUnderscore ?? "").slice(2, -2);
      rendered.push(<strong key={key} className="font-bold text-slate-100">{renderInlineMarkdown(value, key)}</strong>);
    } else if (strike) {
      rendered.push(<del key={key}>{strike.slice(2, -2)}</del>);
    } else if (italic) {
      rendered.push(<em key={key}>{renderInlineMarkdown(italic, key)}</em>);
    } else if (linkLabel && linkUrl) {
      rendered.push(
        <a key={key} href={linkUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline">
          {linkLabel}
        </a>,
      );
    }
    cursor = start + token.length;
    index += 1;
  }
  if (cursor < content.length) rendered.push(content.slice(cursor));
  return rendered.length > 0 ? rendered : [content];
}

function renderAssistantContent(content: string) {
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const rendered: React.ReactNode[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | null = null;
  let listItems: string[] = [];
  let blockIndex = 0;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) {
      rendered.push(
        <p key={`paragraph-${blockIndex++}`} className="leading-6 lg:leading-7">
          {renderInlineMarkdown(text, `paragraph-${blockIndex}`)}
        </p>,
      );
    }
    paragraph = [];
  };
  const flushList = () => {
    if (!listType || listItems.length === 0) return;
    const Tag = listType;
    rendered.push(
      <Tag
        key={`list-${blockIndex++}`}
        className={`${listType === "ol" ? "list-decimal" : "list-disc"} my-2 list-inside space-y-1 pl-2 lg:my-3`}
      >
        {listItems.map((item, index) => (
          <li key={`list-item-${index}`}>{renderInlineMarkdown(item, `list-${blockIndex}-${index}`)}</li>
        ))}
      </Tag>,
    );
    listType = null;
    listItems = [];
  };
  const flushTextBlocks = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fence = /^\s*(```|~~~)(.*)$/.exec(line);
    if (fence) {
      flushTextBlocks();
      const codeLines: string[] = [];
      const marker = fence[1];
      const language = fence[2].trim();
      while (++index < lines.length && !new RegExp(`^\\s*${marker}`).test(lines[index])) {
        codeLines.push(lines[index]);
      }
      rendered.push(
        <div key={`code-${blockIndex++}`} className="my-3 overflow-hidden rounded-xl border border-cyan-500/20 bg-slate-950 lg:my-4">
          <div className="border-b border-slate-800 px-3 py-2 text-[10px] font-semibold uppercase tracking-widest text-cyan-300">
            {language || "code"}
          </div>
          <pre className="max-h-[50dvh] overflow-auto p-3 text-sm leading-5 text-slate-200 lg:max-h-[60dvh]"><code>{codeLines.join("\n")}</code></pre>
        </div>,
      );
      continue;
    }

    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flushTextBlocks();
      const level = heading[1].length;
      const Heading = MARKDOWN_HEADING_TAGS[level] ?? "h2";
      rendered.push(createElement(
        Heading,
        {
          key: `heading-${blockIndex++}`,
          className: "my-2 text-sm font-bold text-slate-100 lg:my-3",
        },
        renderInlineMarkdown(heading[2], `heading-${blockIndex}`),
      ));
      continue;
    }

    const listItem = /^\s*(?:(?:[-*+])\s+|(\d+)[.)]\s+)(.*)$/.exec(line);
    if (listItem) {
      flushParagraph();
      const nextListType = listItem[1] ? "ol" : "ul";
      if (listType && listType !== nextListType) flushList();
      listType = nextListType;
      listItems.push(listItem[2]);
      continue;
    }

    if (/^\s*>/.test(line)) {
      flushTextBlocks();
      const quoteLines = [line.replace(/^\s*>\s?/, "")];
      while (index + 1 < lines.length && /^\s*>/.test(lines[index + 1])) {
        quoteLines.push(lines[++index].replace(/^\s*>\s?/, ""));
      }
      rendered.push(
        <blockquote key={`quote-${blockIndex++}`} className="my-2 border-l-2 border-cyan-500/50 pl-3 text-slate-300 lg:my-3">
          {renderInlineMarkdown(quoteLines.join(" "), `quote-${blockIndex}`)}
        </blockquote>,
      );
      continue;
    }

    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushTextBlocks();
      rendered.push(<hr key={`rule-${blockIndex++}`} className="my-3 border-slate-700 lg:my-4" />);
      continue;
    }

    if (!line.trim()) {
      flushTextBlocks();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushTextBlocks();
  return rendered;
}

export function CodingChatPanel() {
  const [messages, setMessages] = useState<CodingStoredMessage[]>([INITIAL_MESSAGE]);
  const [chatThreads, setChatThreads] = useState<CodingChatThread[]>([]);
  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>(null);
  const [chatHistoryWorkspaceId, setChatHistoryWorkspaceId] = useState<string | null>(null);
  const [showChatHistory, setShowChatHistory] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  const [files, setFiles] = useState<CodingFile[]>([]);
  const [workspaces, setWorkspaces] = useState<CodingWorkspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("Nexus Code Workspace");
  const [workspaceRevisionId, setWorkspaceRevisionId] = useState<string | null>(null);
  const [workspaceParentRevisionId, setWorkspaceParentRevisionId] = useState<string | null>(null);
  const [workspaceStatus, setWorkspaceStatus] = useState("Loading workspace");
  const [codingDeployment, setCodingDeployment] = useState<CodingDeployment | null>(null);
  const [deploymentKind, setDeploymentKind] = useState<CodingDeploymentKind>("static");
  const [deploymentEnvironmentText, setDeploymentEnvironmentText] = useState("");
  const [deploymentBusy, setDeploymentBusy] = useState(false);
  const [deploymentUploadStarted, setDeploymentUploadStarted] = useState(false);
  const [fullstackDeploymentAvailable, setFullstackDeploymentAvailable] = useState(false);
  const [deploymentProgress, setDeploymentProgress] = useState<string | null>(null);
  const [deploymentBuildLogs, setDeploymentBuildLogs] = useState("");
  const [deploymentError, setDeploymentError] = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState(false);
  const [githubLogin, setGithubLogin] = useState<string | null>(null);
  const [githubRepositories, setGithubRepositories] = useState<Array<{
    fullName: string;
    private: boolean;
    defaultBranch: string | null;
  }>>([]);
  const [selectedGitHubRepository, setSelectedGitHubRepository] = useState("");
  const [githubCommitMessage, setGithubCommitMessage] = useState("Publish from Nexus Code");
  const [githubLoading, setGithubLoading] = useState(true);
  const [githubPublishing, setGithubPublishing] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubNotice, setGithubNotice] = useState<string | null>(null);
  const [githubCommitUrl, setGithubCommitUrl] = useState<string | null>(null);
  const [zipExporting, setZipExporting] = useState(false);
  const [zipImporting, setZipImporting] = useState(false);
  const [localEnvironmentContent, setLocalEnvironmentContent] = useState<string | null>(null);
  const [localEnvironmentWorkspaceId, setLocalEnvironmentWorkspaceId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [attachedFileNames, setAttachedFileNames] = useState<string[]>([]);
  const [attachedImages, setAttachedImages] = useState<CodingChatImage[]>([]);
  const [mode, setMode] = useState<CodingMode>("ask");
  const [agent, setAgent] = useState<CodingAgent>("deepseek-chat");
  const [focusedContextEnabled, setFocusedContextEnabled] = useState(false);
  const [contextScopeNotice, setContextScopeNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [error, setError] = useState<string | null>(null);
  const [selectedFileName, setSelectedFileName] = useState<string | null>(null);
  const [codingSurface, setCodingSurface] = useState<CodingSurface>("assistant");
  const [showFiles, setShowFiles] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);
  const [webContainerTerminalCollapsed, setWebContainerTerminalCollapsed] = useState(false);
  const [previewUrlDraft, setPreviewUrlDraft] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [livePreview, setLivePreview] = useState<CodingPreview | null>(null);
  const [previewRuntime, setPreviewRuntime] = useState<"webcontainer" | "runner">("webcontainer");
  const [webContainerStatus, setWebContainerStatus] = useState<CodingWebContainerStatus>("stopped");
  const [webContainerLogs, setWebContainerLogs] = useState("");
  const [webContainerNeedsTopLevel, setWebContainerNeedsTopLevel] = useState(false);
  const [webContainerReloadRequired, setWebContainerReloadRequired] = useState(false);
  const [livePreviewCommand, setLivePreviewCommand] = useState("npm install && npm run dev");
  const [livePreviewPort, setLivePreviewPort] = useState("3000");
  const [livePreviewNetwork, setLivePreviewNetwork] = useState(true);
  const [voiceModeEnabled, setVoiceModeEnabled] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState<CodingVoiceStatus>("off");
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const staticDeploymentAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const zipImportInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lineNumberGutterRef = useRef<HTMLDivElement>(null);
  const selectedFileEditorRef = useRef<HTMLTextAreaElement>(null);
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
  const workspaceSaveTimerRef = useRef<number | null>(null);
  const savedChatHistorySignatureRef = useRef("");
  const webContainerRuntimeRef = useRef<WebContainer | null>(null);
  const webContainerProcessesRef = useRef(new Set<WebContainerProcess>());
  const webContainerPreviewProcessRef = useRef<WebContainerProcess | null>(null);
  const webContainerUnsubscribeRef = useRef<Unsubscribe | null>(null);
  const webContainerGenerationRef = useRef(0);
  const webContainerReadyRef = useRef(false);
  const webContainerSyncedFilesRef = useRef<Set<string>>(new Set());
  const webContainerSyncQueueRef = useRef(Promise.resolve());
  const webContainerTerminalRef = useRef<HTMLPreElement>(null);
  const localEnvironmentFile = useMemo<CodingFile | null>(() => (
    workspaceId
    && localEnvironmentWorkspaceId === workspaceId
    && localEnvironmentContent !== null
      ? {
          name: LOCAL_ENV_FILE_NAME,
          content: localEnvironmentContent,
          language: "dotenv",
        }
      : null
  ), [localEnvironmentContent, localEnvironmentWorkspaceId, workspaceId]);
  const editorFiles = useMemo(() => {
    const sharedFiles = files.filter((file) => file.name !== LOCAL_ENV_FILE_NAME);
    return localEnvironmentFile ? [...sharedFiles, localEnvironmentFile] : sharedFiles;
  }, [files, localEnvironmentFile]);
  const fileTree = useMemo(() => buildCodingTree(editorFiles), [editorFiles]);
  const selectedFile = useMemo(
    () => editorFiles.find((file) => file.name === selectedFileName) ?? null,
    [editorFiles, selectedFileName],
  );
  const editorLineNumbers = useMemo(
    () => selectedFile?.content.split(/\r\n|\n|\r/) ?? [""],
    [selectedFile?.content],
  );
  const selectedFileIsHtml = selectedFile?.language === "html"
    || /\.(?:html?|xhtml)$/i.test(selectedFile?.name ?? "");
  const selectedFileCanPreview = Boolean(selectedFile && selectedFileIsHtml);
  useEffect(() => {
    if (selectedFileEditorRef.current) selectedFileEditorRef.current.scrollTop = 0;
    if (lineNumberGutterRef.current) lineNumberGutterRef.current.scrollTop = 0;
  }, [selectedFileName]);
  const workspaceFilesAreSaved = useMemo(
    () => JSON.stringify(files) === workspaceSyncedFilesRef.current,
    [files, workspaceRevisionId],
  );
  const codingDeploymentId = codingDeployment?.id;
  const codingDeploymentStatus = codingDeployment?.status;
  const deploymentInProgress = codingDeploymentStatus === "queued"
    || codingDeploymentStatus === "building"
    || codingDeploymentStatus === "deploying";

  const loadGitHubConnection = useCallback(async () => {
    setGithubLoading(true);
    try {
      const response = await fetch("/api/coding/github/repos", {
        cache: "no-store",
        credentials: "same-origin",
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errorPayload = payload as { error?: unknown } | null;
        throw new Error(typeof errorPayload?.error === "string" ? errorPayload.error : "GitHub status could not be loaded.");
      }
      const parsed = CodingGitHubRepositoriesResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("GitHub returned an invalid repository list.");
      setGithubConnected(parsed.data.connected);
      setGithubLogin(parsed.data.login);
      setGithubRepositories(parsed.data.repositories);
      setSelectedGitHubRepository((current) => (
        parsed.data.repositories.some((repository) => repository.fullName === current)
          ? current
          : parsed.data.repositories[0]?.fullName ?? ""
      ));
      if (!parsed.data.connected) {
        setGithubLogin(null);
        setGithubRepositories([]);
        setSelectedGitHubRepository("");
      }
      setGithubError(null);
    } catch (loadError) {
      setGithubError(loadError instanceof Error ? loadError.message : "GitHub status could not be loaded.");
    } finally {
      setGithubLoading(false);
    }
  }, []);

  const exportWorkspaceZip = useCallback(async () => {
    setZipExporting(true);
    setGithubError(null);
    setGithubNotice(null);
    setError(null);
    try {
      const { blob, filename } = await createCodingWorkspaceZip(files, workspaceName);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.rel = "noopener";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      setGithubNotice(`${filename} is ready to download.`);
    } catch (exportError) {
      const message = exportError instanceof Error ? exportError.message : "ZIP export failed.";
      setGithubError(message);
      setError(message);
    } finally {
      setZipExporting(false);
    }
  }, [files, workspaceName]);

  const publishWorkspaceToGitHub = useCallback(async () => {
    if (!workspaceId || !workspaceRevisionId || !selectedGitHubRepository) return;
    if (!workspaceFilesAreSaved) {
      setGithubError("Wait for project changes to finish saving before publishing.");
      return;
    }
    const confirmed = window.confirm(
      `Publish ${workspaceName} to ${selectedGitHubRepository} on its default branch? Matching file paths will be overwritten; other repository files will be kept.`,
    );
    if (!confirmed) return;
    setGithubPublishing(true);
    setGithubError(null);
    setGithubNotice(null);
    setGithubCommitUrl(null);
    try {
      const response = await fetch("/api/coding/github/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          workspaceId,
          revisionId: workspaceRevisionId,
          repository: selectedGitHubRepository,
          message: githubCommitMessage,
        }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errorPayload = payload as { error?: unknown } | null;
        throw new Error(typeof errorPayload?.error === "string" ? errorPayload.error : "GitHub publishing failed.");
      }
      const parsed = CodingGitHubPublishResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("GitHub returned an invalid publishing result.");
      setGithubCommitUrl(parsed.data.commitUrl);
      setGithubNotice(`Published ${parsed.data.fileCount} files to ${parsed.data.repository} (${parsed.data.branch}).`);
    } catch (publishError) {
      setGithubError(publishError instanceof Error ? publishError.message : "GitHub publishing failed.");
    } finally {
      setGithubPublishing(false);
    }
  }, [githubCommitMessage, selectedGitHubRepository, workspaceFilesAreSaved, workspaceId, workspaceName, workspaceRevisionId]);

  const deployCodingWorkspace = useCallback(async () => {
    if (!workspaceId || !workspaceRevisionId) {
      setDeploymentError("Create or open a coding project before deploying.");
      return;
    }
    if (!workspaceFilesAreSaved) {
      setDeploymentError("Wait for project changes to finish saving before deploying.");
      return;
    }
    let environment: Record<string, string> = {};
    if (deploymentKind === "fullstack") {
      try {
        environment = parseCodingDeploymentEnvironmentText(deploymentEnvironmentText);
      } catch (parseError) {
        setDeploymentError(parseError instanceof Error ? parseError.message : "Runtime environment variables are invalid.");
        return;
      }
    }
    if (!window.confirm(
      deploymentKind === "static"
        ? `Build and publish ${workspaceName} as a static site through EpicGlobal? The built files will be uploaded to your existing host; no GitHub repository or container registry is used.`
        : `Deploy ${workspaceName} as a full-stack Node.js app to your EpicGlobal Droplet? The project will be public at an EpicGlobal URL. Runtime variables are sent to the host but are not saved in the Nexus workspace. No GitHub repository or container registry is used.`,
    )) return;

    setDeploymentBusy(true);
    setDeploymentUploadStarted(false);
    setDeploymentError(null);
    setDeploymentProgress(null);
    setDeploymentBuildLogs("");
    let staticAbortController: AbortController | null = null;
    let staticUploadStarted = false;
    try {
      let response: Response;
      if (deploymentKind === "static") {
        staticAbortController = new AbortController();
        staticDeploymentAbortRef.current = staticAbortController;
        const artifact = await buildCodingStaticArtifact(files, {
          signal: staticAbortController.signal,
          onProgress: setDeploymentProgress,
          onOutput: (chunk) => setDeploymentBuildLogs((current) => `${current}${chunk}`.slice(-12_000)),
        });
        setDeploymentProgress("Uploading the built site to EpicGlobal...");
        setDeploymentUploadStarted(true);
        staticUploadStarted = true;
        staticDeploymentAbortRef.current = null;
        response = await fetch(
          `/api/coding/workspaces/${encodeURIComponent(workspaceId)}/deployments/static`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/zip",
              "x-coding-revision-id": workspaceRevisionId,
            },
            credentials: "same-origin",
            body: artifact,
          },
        );
      } else {
        response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/deployments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            revisionId: workspaceRevisionId,
            kind: deploymentKind,
            environment,
            confirmDeployment: true,
          }),
        });
      }
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = payload as { error?: unknown } | null;
        const failedDeployment = CodingDeploymentResponseSchema.safeParse({
          deployment: (failure as { deployment?: unknown } | null)?.deployment,
        });
        if (failedDeployment.success) setCodingDeployment(failedDeployment.data.deployment);
        throw new Error(typeof failure?.error === "string" ? failure.error : "Project deployment could not start.");
      }
      const parsed = CodingDeploymentResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Nexus returned an invalid deployment response.");
      setCodingDeployment(parsed.data.deployment);
      setDeploymentKind(parsed.data.deployment.kind);
    } catch (deployError) {
      setDeploymentError(deployError instanceof Error ? deployError.message : "Project deployment could not start.");
      if (staticUploadStarted && workspaceId) {
        try {
          const statusResponse = await fetch(
            `/api/coding/workspaces/${encodeURIComponent(workspaceId)}/deployments`,
            { cache: "no-store", credentials: "same-origin" },
          );
          const statusPayload: unknown = await statusResponse.json().catch(() => null);
          const deployments = CodingDeploymentListResponseSchema.safeParse(statusPayload);
          if (!statusResponse.ok || !deployments.success) {
            throw new Error("Deployment status could not be refreshed after the upload.");
          }
          setCodingDeployment(deployments.data.deployments[0] ?? null);
          setFullstackDeploymentAvailable(deployments.data.capabilities.fullstack);
        } catch (refreshError) {
          console.error("[coding/deployments] Could not refresh status after static upload", refreshError);
        }
      }
    } finally {
      if (staticDeploymentAbortRef.current === staticAbortController) {
        staticDeploymentAbortRef.current = null;
      }
      setDeploymentBusy(false);
      setDeploymentUploadStarted(false);
      setDeploymentProgress(null);
    }
  }, [deploymentEnvironmentText, deploymentKind, files, workspaceFilesAreSaved, workspaceId, workspaceName, workspaceRevisionId]);

  const stopCodingDeployment = useCallback(async () => {
    if (!workspaceId || !codingDeployment) return;
    if (!window.confirm(
      codingDeployment.url
        ? `Take ${codingDeployment.url} offline? This removes the deployed project from EpicGlobal.`
        : "Cancel this deployment?",
    )) return;
    setDeploymentError(null);
    try {
      const response = await fetch(
        `/api/coding/workspaces/${encodeURIComponent(workspaceId)}/deployments/${encodeURIComponent(codingDeployment.id)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ confirmDeletion: true }),
        },
      );
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = payload as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : "The deployed project could not be removed.");
      }
      const parsed = CodingDeploymentResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Nexus returned an invalid deployment response.");
      setCodingDeployment(parsed.data.deployment);
    } catch (deleteError) {
      setDeploymentError(deleteError instanceof Error ? deleteError.message : "The deployed project could not be removed.");
    }
  }, [codingDeployment, workspaceId]);

  const disconnectGitHub = useCallback(async () => {
    setGithubLoading(true);
    setGithubError(null);
    try {
      const response = await fetch("/api/coding/github/disconnect", {
        method: "POST",
        credentials: "same-origin",
      });
      if (!response.ok) throw new Error("GitHub could not be disconnected.");
      setGithubConnected(false);
      setGithubLogin(null);
      setGithubRepositories([]);
      setSelectedGitHubRepository("");
      setGithubCommitUrl(null);
      setGithubNotice("GitHub has been disconnected from this browser.");
    } catch (disconnectError) {
      setGithubError(disconnectError instanceof Error ? disconnectError.message : "GitHub could not be disconnected.");
    } finally {
      setGithubLoading(false);
    }
  }, []);

  useEffect(() => {
    const callbackError = new URLSearchParams(window.location.search).get("github_error");
    void (async () => {
      await loadGitHubConnection();
      if (!callbackError) return;
      setGithubError(callbackError);
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete("github_error");
      window.history.replaceState(null, "", `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    })();
  }, [loadGitHubConnection]);

  useEffect(() => {
    if (!workspaceId) {
      setCodingDeployment(null);
      setDeploymentError(null);
      setFullstackDeploymentAvailable(false);
      return;
    }
    let active = true;
    setCodingDeployment(null);
    setDeploymentError(null);
    setFullstackDeploymentAvailable(false);
    void (async () => {
      try {
        const response = await fetch(
          `/api/coding/workspaces/${encodeURIComponent(workspaceId)}/deployments`,
          { cache: "no-store", credentials: "same-origin" },
        );
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const failure = payload as { error?: unknown } | null;
          throw new Error(typeof failure?.error === "string" ? failure.error : "Deployment status could not be loaded.");
        }
        const parsed = CodingDeploymentListResponseSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Nexus returned invalid deployment history.");
        if (active) {
          const deployment = parsed.data.deployments[0] ?? null;
          setCodingDeployment(deployment);
          if (deployment) setDeploymentKind(deployment.kind);
          setFullstackDeploymentAvailable(parsed.data.capabilities.fullstack);
        }
      } catch (loadError) {
        if (active) setDeploymentError(loadError instanceof Error ? loadError.message : "Deployment status could not be loaded.");
      }
    })();
    return () => {
      active = false;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (
      !workspaceId
      || !codingDeploymentId
      || !codingDeploymentStatus
      || codingDeploymentStatus === "active"
      || codingDeploymentStatus === "failed"
      || codingDeploymentStatus === "stopped"
    ) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const response = await fetch(
          `/api/coding/workspaces/${encodeURIComponent(workspaceId)}/deployments/${encodeURIComponent(codingDeploymentId)}`,
          { cache: "no-store", credentials: "same-origin" },
        );
        const payload: unknown = await response.json().catch(() => null);
        if (!response.ok) {
          const failure = payload as { error?: unknown } | null;
          throw new Error(typeof failure?.error === "string" ? failure.error : "Deployment status could not be loaded.");
        }
        const parsed = CodingDeploymentResponseSchema.safeParse(payload);
        if (!parsed.success) throw new Error("Nexus returned invalid deployment status.");
        if (active) {
          setCodingDeployment(parsed.data.deployment);
          setDeploymentKind(parsed.data.deployment.kind);
          setDeploymentError(null);
        }
      } catch (pollError) {
        if (active) setDeploymentError(pollError instanceof Error ? pollError.message : "Deployment status could not be loaded.");
      } finally {
        if (active) timer = window.setTimeout(poll, 4000);
      }
    };
    timer = window.setTimeout(poll, 1500);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [codingDeploymentId, codingDeploymentStatus, workspaceId]);

  useEffect(() => {
    if (selectedFileName && editorFiles.some((file) => file.name === selectedFileName)) return;
    setSelectedFileName(editorFiles[0]?.name ?? null);
  }, [editorFiles, selectedFileName]);

  useEffect(() => {
    if (!workspaceId) {
      setLocalEnvironmentWorkspaceId(null);
      setLocalEnvironmentContent(null);
      return;
    }
    try {
      setLocalEnvironmentContent(loadCodingLocalEnvironment(workspaceId));
      setLocalEnvironmentWorkspaceId(workspaceId);
    } catch (localEnvironmentError) {
      setLocalEnvironmentContent(null);
      setLocalEnvironmentWorkspaceId(workspaceId);
      setError(localEnvironmentError instanceof Error
        ? localEnvironmentError.message
        : "Device-local .env.local could not be loaded.");
    }
  }, [workspaceId]);

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
  }, []);

  useEffect(() => () => {
    webContainerGenerationRef.current += 1;
    staticDeploymentAbortRef.current?.abort();
    webContainerUnsubscribeRef.current?.();
    webContainerProcessesRef.current.forEach((process) => process.kill());
    webContainerProcessesRef.current.clear();
    webContainerRuntimeRef.current = null;
    void teardownCodingWebContainer().catch((runtimeError: unknown) => {
      console.error("[coding] Failed to stop WebContainer", runtimeError);
    });
  }, []);

  useEffect(() => {
    const terminal = webContainerTerminalRef.current;
    if (terminal) terminal.scrollTop = terminal.scrollHeight;
  }, [webContainerLogs]);

  const isolateWorkspaceFiles = useCallback((
    targetWorkspaceId: string,
    revisionFiles: CodingWorkspaceFile[],
  ): CodingWorkspaceFile[] => {
    const legacyLocalEnvironment = revisionFiles.find((file) => file.name === LOCAL_ENV_FILE_NAME);
    const sharedFiles = revisionFiles.filter((file) => file.name !== LOCAL_ENV_FILE_NAME);
    if (!legacyLocalEnvironment) return sharedFiles;

    let content = legacyLocalEnvironment.content;
    try {
      const saved = loadCodingLocalEnvironment(targetWorkspaceId);
      if (saved === null) saveCodingLocalEnvironment(targetWorkspaceId, content);
      else content = saved;
    } catch (localEnvironmentError) {
      setError(localEnvironmentError instanceof Error
        ? localEnvironmentError.message
        : "Legacy .env.local could not be moved to this browser.");
    }
    setLocalEnvironmentWorkspaceId(targetWorkspaceId);
    setLocalEnvironmentContent(content);
    return ensureLocalEnvironmentGitignore(sharedFiles);
  }, []);

  const applyWorkspaceSnapshot = useCallback((snapshot: CodingWorkspaceSnapshot) => {
    const hasLocalEnvironment = snapshot.revision.files.some(
      (file) => file.name === LOCAL_ENV_FILE_NAME,
    );
    const nextFiles = isolateWorkspaceFiles(snapshot.workspace.id, snapshot.revision.files);
    workspaceReadyRef.current = false;
    workspaceIdRef.current = snapshot.workspace.id;
    workspaceRevisionRef.current = snapshot.workspace.currentRevisionId;
    workspaceSyncedFilesRef.current = JSON.stringify(snapshot.revision.files);
    setWorkspaceId(snapshot.workspace.id);
    setWorkspaceName(snapshot.workspace.name);
    setWorkspaceRevisionId(snapshot.workspace.currentRevisionId);
    setWorkspaceParentRevisionId(snapshot.revision.parentRevisionId);
    setCodingDeployment(null);
    setDeploymentEnvironmentText("");
    setDeploymentError(null);
    setSelectedFileName(nextFiles[0]?.name ?? (hasLocalEnvironment ? LOCAL_ENV_FILE_NAME : null));
    setFiles(nextFiles);
    setLivePreview(null);
    setPreviewUrl("");
    workspaceReadyRef.current = true;
    setWorkspaceStatus("Saved");
  }, [isolateWorkspaceFiles]);

  useEffect(() => {
    savedChatHistorySignatureRef.current = "";
    setShowChatHistory(false);
    if (!workspaceId) {
      setChatThreads([]);
      setActiveChatThreadId(null);
      setChatHistoryWorkspaceId(null);
      setMessages([{ ...INITIAL_MESSAGE, createdAt: new Date().toISOString() }]);
      return;
    }

    setChatHistoryWorkspaceId(null);
    try {
      const history = loadCodingChatHistory(workspaceId, {
        ...INITIAL_MESSAGE,
        createdAt: new Date().toISOString(),
      });
      const activeThread = history.threads.find((thread) => thread.id === history.activeThreadId);
      if (!activeThread) throw new Error("The active chat could not be found in project history.");
      setChatThreads(history.threads);
      setActiveChatThreadId(history.activeThreadId);
      setMessages(activeThread.messages);
      setChatHistoryWorkspaceId(workspaceId);
    } catch (historyError) {
      const freshThread = createCodingChatThread([
        { ...INITIAL_MESSAGE, createdAt: new Date().toISOString() },
      ]);
      setChatThreads([freshThread]);
      setActiveChatThreadId(freshThread.id);
      setMessages(freshThread.messages);
      setChatHistoryWorkspaceId(workspaceId);
      savedChatHistorySignatureRef.current = JSON.stringify({
        activeThreadId: freshThread.id,
        threads: [freshThread],
      });
      setError(historyError instanceof Error
        ? historyError.message
        : "Project chat history could not be loaded.");
    }
  }, [workspaceId]);

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
    setAttachedImages([]);
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
    if (!window.confirm(`Delete "${projectName}" permanently? All files, revisions, and this browser's project chat history will be removed.`)) return;
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
      try {
        deleteCodingLocalEnvironment(workspaceId);
      } catch (localEnvironmentError) {
        setError(localEnvironmentError instanceof Error
          ? localEnvironmentError.message
          : "Device-local .env.local could not be removed.");
      }
      try {
        deleteCodingChatHistory(workspaceId);
      } catch (historyError) {
        setError(historyError instanceof Error
          ? historyError.message
          : "Project chat history could not be removed.");
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
  }, [codingSurface, loading, messages]);

  useEffect(() => {
    if (!workspaceId || chatHistoryWorkspaceId !== workspaceId || !activeChatThreadId) return;
    const activeThread = chatThreads.find((thread) => thread.id === activeChatThreadId);
    if (!activeThread) return;

    const nextMessages = messages.slice(-80);
    const messagesChanged = JSON.stringify(activeThread.messages) !== JSON.stringify(nextMessages);
    const nextTitle = activeThread.title === "New chat"
      ? codingChatThreadTitle(nextMessages)
      : activeThread.title;
    const titleChanged = nextTitle !== activeThread.title;
    const now = new Date().toISOString();
    const nextActiveThread = messagesChanged || titleChanged
      ? {
          ...activeThread,
          title: nextTitle,
          messages: nextMessages,
          updatedAt: now,
        }
      : activeThread;
    const nextThreads = [
      nextActiveThread,
      ...chatThreads.filter((thread) => thread.id !== activeChatThreadId),
    ]
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 20);
    const signature = JSON.stringify({
      activeThreadId: activeChatThreadId,
      threads: nextThreads,
    });

    if (signature !== savedChatHistorySignatureRef.current) {
      try {
        saveCodingChatHistory(workspaceId, {
          version: 1,
          activeThreadId: activeChatThreadId,
          threads: nextThreads,
          updatedAt: now,
        });
        savedChatHistorySignatureRef.current = signature;
      } catch (historyError) {
        setError(historyError instanceof Error
          ? historyError.message
          : "Project chat history could not be saved.");
      }
    }
    if (JSON.stringify(nextThreads) !== JSON.stringify(chatThreads)) {
      setChatThreads(nextThreads);
    }
  }, [
    activeChatThreadId,
    chatHistoryWorkspaceId,
    chatThreads,
    messages,
    workspaceId,
  ]);

  const startNewChat = useCallback(() => {
    if (!workspaceId || chatHistoryWorkspaceId !== workspaceId) {
      setError("Open a project before starting a new chat.");
      return;
    }
    abortRef.current?.abort();
    setLoading(false);
    setStatus("Ready");
    setInput("");
    setAttachedFileNames([]);
    setAttachedImages([]);
    setCodingSurface("assistant");
    setShowFiles(false);
    setShowPreview(false);
    setShowChatHistory(false);
    const now = new Date().toISOString();
    const currentThread = chatThreads.find((thread) => thread.id === activeChatThreadId);
    const updatedCurrentThread = currentThread
      ? {
          ...currentThread,
          title: currentThread.title === "New chat"
            ? codingChatThreadTitle(messages)
            : currentThread.title,
          messages: messages.slice(-80),
          updatedAt: now,
        }
      : null;
    const nextThread = createCodingChatThread([
      { ...INITIAL_MESSAGE, createdAt: now },
    ], "New chat", now);
    const nextThreads = [
      nextThread,
      ...(updatedCurrentThread ? [updatedCurrentThread] : []),
      ...chatThreads.filter((thread) => (
        thread.id !== activeChatThreadId && thread.id !== nextThread.id
      )),
    ].slice(0, 20);
    const history = {
      version: 1 as const,
      activeThreadId: nextThread.id,
      threads: nextThreads,
      updatedAt: now,
    };
    try {
      saveCodingChatHistory(workspaceId, history);
      savedChatHistorySignatureRef.current = JSON.stringify({
        activeThreadId: history.activeThreadId,
        threads: history.threads,
      });
      setError(null);
    } catch (historyError) {
      setError(historyError instanceof Error
        ? historyError.message
        : "The new chat could not be saved in project history.");
    }
    setChatThreads(nextThreads);
    setActiveChatThreadId(nextThread.id);
    setMessages(nextThread.messages);
  }, [
    activeChatThreadId,
    chatHistoryWorkspaceId,
    chatThreads,
    messages,
    workspaceId,
  ]);

  const openChatThread = useCallback((threadId: string) => {
    const thread = chatThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    abortRef.current?.abort();
    setLoading(false);
    setStatus("Ready");
    setInput("");
    setAttachedFileNames([]);
    setAttachedImages([]);
    setActiveChatThreadId(thread.id);
    setMessages(thread.messages);
    setShowChatHistory(false);
    setCodingSurface("assistant");
    setError(null);
  }, [chatThreads]);

  const deleteChatThread = useCallback((threadId: string) => {
    if (!workspaceId || chatHistoryWorkspaceId !== workspaceId) return;
    const thread = chatThreads.find((candidate) => candidate.id === threadId);
    if (!thread) return;
    const title = thread.title === "New chat"
      ? codingChatThreadTitle(thread.messages)
      : thread.title;
    if (!window.confirm(`Delete "${title}" from chat history? This cannot be undone.`)) return;

    const now = new Date().toISOString();
    const remainingThreads = chatThreads.filter((candidate) => candidate.id !== threadId);
    const nextThreads = remainingThreads.length > 0
      ? remainingThreads
      : [createCodingChatThread([{ ...INITIAL_MESSAGE, createdAt: now }], "New chat", now)];
    const nextActiveThread = nextThreads.find((candidate) => candidate.id === activeChatThreadId)
      ?? nextThreads[0];
    const history = {
      version: 1 as const,
      activeThreadId: nextActiveThread.id,
      threads: nextThreads,
      updatedAt: now,
    };

    try {
      saveCodingChatHistory(workspaceId, history);
      savedChatHistorySignatureRef.current = JSON.stringify({
        activeThreadId: history.activeThreadId,
        threads: history.threads,
      });
    } catch (historyError) {
      setError(historyError instanceof Error
        ? historyError.message
        : "The chat could not be deleted from project history.");
      return;
    }

    setChatThreads(nextThreads);
    setActiveChatThreadId(nextActiveThread.id);
    if (threadId === activeChatThreadId) {
      abortRef.current?.abort();
      setLoading(false);
      setStatus("Ready");
      setInput("");
      setAttachedFileNames([]);
      setAttachedImages([]);
      setMessages(nextActiveThread.messages);
    }
    setError(null);
  }, [activeChatThreadId, chatHistoryWorkspaceId, chatThreads, workspaceId]);

  const showProjectChatHistory = useCallback(() => {
    if (chatHistoryWorkspaceId !== workspaceId) return;
    setCodingSurface("assistant");
    setShowFiles(false);
    setShowPreview(false);
    setShowChatHistory(true);
  }, [chatHistoryWorkspaceId, workspaceId]);

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
            setFiles(isolateWorkspaceFiles(
              parsedCurrent.data.workspace.id,
              parsedCurrent.data.revision.files,
            ));
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
  }, [isolateWorkspaceFiles, workspaceId]);

  const flushWorkspaceSave = useCallback(async () => {
    if (!workspaceId || !workspaceReadyRef.current) return;
    if (workspaceSaveTimerRef.current !== null) {
      window.clearTimeout(workspaceSaveTimerRef.current);
      workspaceSaveTimerRef.current = null;
    }
    const signature = JSON.stringify(files);
    if (signature !== workspaceSyncedFilesRef.current) {
      queueWorkspaceSave(
        files,
        workspaceChangeReasonRef.current,
        workspaceChangeSourceRef.current,
      );
    }
    await workspaceSaveQueueRef.current;
    if (signature !== workspaceSyncedFilesRef.current) {
      throw new Error("The current project changes could not be saved.");
    }
  }, [files, queueWorkspaceSave, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !workspaceReadyRef.current) return;
    const signature = JSON.stringify(files);
    if (signature === workspaceSyncedFilesRef.current) return;
    const timer = window.setTimeout(() => {
      if (workspaceSaveTimerRef.current === timer) workspaceSaveTimerRef.current = null;
      queueWorkspaceSave(
        files,
        workspaceChangeReasonRef.current,
        workspaceChangeSourceRef.current,
      );
    }, 800);
    workspaceSaveTimerRef.current = timer;
    return () => {
      window.clearTimeout(timer);
      if (workspaceSaveTimerRef.current === timer) workspaceSaveTimerRef.current = null;
    };
  }, [files, queueWorkspaceSave, workspaceId]);

  const addFiles = useCallback(async (selected: FileList | null, attachToChat = false) => {
    if (!selected) return;
    const nextFiles: CodingFile[] = [];
    let localEnvironment: string | null = null;
    let warning: string | null = null;
    for (const file of Array.from(selected)) {
      if (file.size > MAX_FILE_SIZE) {
        warning = `${file.name} is too large. Keep each source file under 500 KB.`;
        continue;
      }
      const sourcePath = file.webkitRelativePath
        ? file.webkitRelativePath.replaceAll("\\", "/").split("/").slice(1).join("/")
        : file.name;
      const normalizedPath = normalizeCodingFilePath(sourcePath);
      if (!normalizedPath || normalizedPath !== sourcePath.replaceAll("\\", "/")) {
        warning = `${file.name} has an invalid project-relative path and was skipped.`;
        continue;
      }
      if (normalizedPath.split("/").some((segment) => [
        ".git", ".next", ".turbo", ".cache", "node_modules", "coverage", "dist", "build",
      ].includes(segment))) continue;
      if (isPrivateEnvironmentFile(normalizedPath) && normalizedPath !== LOCAL_ENV_FILE_NAME) {
        warning = `${normalizedPath} was skipped. Only .env.local can be kept as a device-local environment file.`;
        continue;
      }
      if (normalizedPath === LOCAL_ENV_FILE_NAME && attachToChat) {
        warning = ".env.local cannot be attached to chat. Import it from the project explorer to keep it device-local.";
        continue;
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      } catch {
        warning = `${normalizedPath} is not UTF-8 text and was skipped.`;
        continue;
      }
      const parsed = CodingWorkspaceFileSchema.safeParse({
        name: normalizedPath,
        content,
        language: codingLanguageFromName(normalizedPath),
      });
      if (!parsed.success) {
        warning = parsed.error.issues[0]?.message ?? `${normalizedPath} is invalid.`;
        continue;
      }
      if (normalizedPath === LOCAL_ENV_FILE_NAME) {
        if (localEnvironment !== null) {
          warning = "Only one root .env.local can be imported at a time.";
          continue;
        }
        localEnvironment = parsed.data.content;
      } else {
        nextFiles.push(parsed.data);
      }
    }

    let mergedFiles = files;
    if (nextFiles.length > 0) {
      const merged = new Map(files.map((file) => [file.name, file]));
      for (const file of nextFiles) merged.set(file.name, file);
      mergedFiles = Array.from(merged.values());
      if (mergedFiles.length > MAX_FILES) {
        setError(`This workspace supports no more than ${MAX_FILES} source files.`);
        return;
      }
      if (codingWorkspaceByteCount(mergedFiles) > MAX_WORKSPACE_BYTES) {
        setError("The imported source files exceed the 4 MB workspace limit.");
        return;
      }
    }

    if (localEnvironment !== null) {
      if (!workspaceId) {
        warning = "Create or open a project before importing its device-local .env.local.";
      } else {
        try {
          saveCodingLocalEnvironment(workspaceId, localEnvironment);
          setLocalEnvironmentWorkspaceId(workspaceId);
          setLocalEnvironmentContent(localEnvironment);
          mergedFiles = ensureLocalEnvironmentGitignore(mergedFiles);
        } catch (localEnvironmentError) {
          setError(localEnvironmentError instanceof Error
            ? localEnvironmentError.message
            : "Device-local .env.local could not be saved.");
          return;
        }
      }
    }

    if (nextFiles.length > 0 || (localEnvironment !== null && workspaceId)) {
      if (attachToChat) {
        setAttachedFileNames((current) => Array.from(new Set([
          ...current,
          ...nextFiles.map((file) => file.name),
        ])));
      }
      workspaceChangeReasonRef.current = "Imported source files";
      workspaceChangeSourceRef.current = "import";
      setFiles(mergedFiles);
      setSelectedFileName(nextFiles[0]?.name ?? LOCAL_ENV_FILE_NAME);
    }
    setError(warning);
  }, [files, workspaceId]);

  const addImages = useCallback(async (selected: FileList | null) => {
    if (!selected) return;
    let warning: string | null = null;
    let totalCharacters = attachedImages.reduce((sum, image) => sum + image.data.length, 0);
    const nextImages: CodingChatImage[] = [];

    for (const file of Array.from(selected)) {
      const mediaType = CODING_IMAGE_MEDIA_TYPES.find((type) => type === file.type);
      if (!mediaType) {
        warning = `${file.name} is not a supported image. Use JPEG, PNG, GIF, or WebP.`;
        continue;
      }
      if (file.size === 0 || file.size > MAX_CODING_IMAGE_BYTES) {
        warning = `${file.name} must be 4 MB or smaller.`;
        continue;
      }
      if (attachedImages.length + nextImages.length >= MAX_CODING_IMAGES) {
        warning = `Attach no more than ${MAX_CODING_IMAGES} images per message.`;
        continue;
      }

      let data: string;
      try {
        data = encodeImageBase64(new Uint8Array(await file.arrayBuffer()));
      } catch {
        warning = `${file.name} could not be read. Choose the image again and retry.`;
        continue;
      }
      if (totalCharacters + data.length > MAX_CODING_IMAGES_BASE64_CHARACTERS) {
        warning = "Attached images are too large. Keep their combined encoded size at or below 8 MB.";
        continue;
      }
      const parsed = CodingChatImageSchema.safeParse({ name: file.name, mediaType, data });
      if (!parsed.success) {
        warning = parsed.error.issues[0]?.message ?? `${file.name} is not a valid image attachment.`;
        continue;
      }
      nextImages.push(parsed.data);
      totalCharacters += data.length;
    }

    if (nextImages.length > 0) {
      setAttachedImages([...attachedImages, ...nextImages]);
      setAgent("deepseek-flash");
    }
    setError(warning);
  }, [attachedImages]);

  const updateSelectedFile = useCallback((content: string) => {
    if (!selectedFileName) return;
    if (selectedFileName === LOCAL_ENV_FILE_NAME) {
      if (!workspaceId) {
        setError("Open a project before editing device-local .env.local.");
        return;
      }
      try {
        saveCodingLocalEnvironment(workspaceId, content);
        setLocalEnvironmentWorkspaceId(workspaceId);
        setLocalEnvironmentContent(content);
        setError(null);
      } catch (localEnvironmentError) {
        setError(localEnvironmentError instanceof Error
          ? localEnvironmentError.message
          : "Device-local .env.local could not be saved.");
      }
      return;
    }
    const nextFiles = files.map((file) => (
      file.name === selectedFileName ? { ...file, content } : file
    ));
    const selected = nextFiles.find((file) => file.name === selectedFileName);
    if (!selected || !CodingWorkspaceFileSchema.safeParse(selected).success) {
      setError("Keep each project source file under 500 KB.");
      return;
    }
    if (codingWorkspaceByteCount(nextFiles) > MAX_WORKSPACE_BYTES) {
      setError("The edited project exceeds the 4 MB workspace limit.");
      return;
    }
    workspaceChangeReasonRef.current = `Edited ${selectedFileName}`;
    workspaceChangeSourceRef.current = "user";
    setFiles(nextFiles);
    setError(null);
  }, [files, selectedFileName, workspaceId]);

  const syncGeneratedFiles = useCallback((content: string) => {
    const extractedFiles = extractCodingFiles(content);
    const generatedFiles = extractedFiles.filter((file) => !isPrivateEnvironmentFile(file.name));
    if (generatedFiles.length !== extractedFiles.length) {
      setError("Environment files were not added to the shared workspace. Create .env.local in the explorer to keep values on this device.");
    }
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

  const createWorkspaceFile = useCallback((defaultPath = "src/new-file.tsx") => {
    const enteredPath = window.prompt("New project-relative file path", defaultPath);
    if (enteredPath === null) return;
    const normalizedPath = normalizeCodingFilePath(enteredPath);
    if (!normalizedPath || normalizedPath !== enteredPath.trim().replaceAll("\\", "/")) {
      setError("Enter a relative path without empty, . or .. path segments.");
      return;
    }
    if (isPrivateEnvironmentFile(normalizedPath) && normalizedPath !== LOCAL_ENV_FILE_NAME) {
      setError("Only .env.local can be created as a device-local environment file.");
      return;
    }
    if (!workspaceId) {
      setError("Create or open a project before adding files.");
      return;
    }
    if (editorFiles.some((file) => (
      file.name === normalizedPath
      || file.name.startsWith(`${normalizedPath}/`)
      || normalizedPath.startsWith(`${file.name}/`)
    ))) {
      setError(`A file or folder already exists at ${normalizedPath}.`);
      return;
    }

    if (normalizedPath === LOCAL_ENV_FILE_NAME) {
      try {
        saveCodingLocalEnvironment(workspaceId, "");
        setLocalEnvironmentWorkspaceId(workspaceId);
        setLocalEnvironmentContent("");
        setFiles(ensureLocalEnvironmentGitignore(files));
        setSelectedFileName(LOCAL_ENV_FILE_NAME);
        setCodingSurface("editor");
        setError(null);
      } catch (localEnvironmentError) {
        setError(localEnvironmentError instanceof Error
          ? localEnvironmentError.message
          : "Device-local .env.local could not be created.");
      }
      return;
    }

    if (files.length >= MAX_FILES) {
      setError(`This workspace supports no more than ${MAX_FILES} source files.`);
      return;
    }
    const parsed = CodingWorkspaceFileSchema.safeParse({
      name: normalizedPath,
      content: "",
      language: codingLanguageFromName(normalizedPath),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "The new file path is invalid.");
      return;
    }
    workspaceChangeReasonRef.current = `Created ${normalizedPath}`;
    workspaceChangeSourceRef.current = "user";
    setFiles([...files, parsed.data]);
    setSelectedFileName(normalizedPath);
    setCodingSurface("editor");
    setError(null);
  }, [editorFiles, files, workspaceId]);

  const deleteWorkspacePath = useCallback((path: string, kind: CodingTreeNode["kind"]) => {
    const removedNames = new Set(editorFiles
      .filter((file) => kind === "folder" ? file.name.startsWith(`${path}/`) : file.name === path)
      .map((file) => file.name));
    if (removedNames.size === 0) return;
    const count = removedNames.size;
    if (!window.confirm(`Delete ${kind === "folder" ? `folder "${path}" and ${count} file${count === 1 ? "" : "s"}` : `"${path}"`}?`)) {
      return;
    }
    if (removedNames.has(LOCAL_ENV_FILE_NAME) && workspaceId) {
      try {
        deleteCodingLocalEnvironment(workspaceId);
      } catch (localEnvironmentError) {
        setError(localEnvironmentError instanceof Error
          ? localEnvironmentError.message
          : "Device-local .env.local could not be deleted.");
        return;
      }
      setLocalEnvironmentContent(null);
      setLocalEnvironmentWorkspaceId(workspaceId);
    }
    const remainingFiles = files.filter((file) => !removedNames.has(file.name));
    const nextSelected = remainingFiles[0]?.name ?? null;
    setSelectedFileName((current) => current && removedNames.has(current) ? nextSelected : current);
    if (removedNames.size > 0 && Array.from(removedNames).some((name) => name !== LOCAL_ENV_FILE_NAME)) {
      workspaceChangeReasonRef.current = `Deleted ${path}`;
      workspaceChangeSourceRef.current = "user";
      setFiles(remainingFiles);
    }
    setError(null);
  }, [editorFiles, files, workspaceId]);

  const importWorkspaceZip = useCallback(async (file: File | null) => {
    if (!file || zipImporting) return;
    setZipImporting(true);
    setError(null);
    try {
      const imported = await readCodingWorkspaceZip(file);
      await flushWorkspaceSave();
      const projectName = file.name.replace(/\.zip$/i, "").trim().slice(0, 80) || "Imported Nexus Project";
      const projectFiles: CodingWorkspaceFile[] = imported.localEnvironment === null
        ? imported.files
        : ensureLocalEnvironmentGitignore(imported.files);
      const response = await fetch("/api/coding/workspaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ name: projectName, files: projectFiles }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const failure = payload as { error?: unknown } | null;
        throw new Error(typeof failure?.error === "string" ? failure.error : "The ZIP project could not be imported.");
      }
      const parsed = CodingWorkspaceSnapshotSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The imported project response was invalid.");

      let environmentError: string | null = null;
      if (imported.localEnvironment !== null) {
        try {
          saveCodingLocalEnvironment(parsed.data.workspace.id, imported.localEnvironment);
        } catch (localEnvironmentError) {
          environmentError = localEnvironmentError instanceof Error
            ? localEnvironmentError.message
            : "Device-local .env.local could not be saved.";
        }
      }
      setWorkspaces((current) => [
        parsed.data.workspace,
        ...current.filter((workspace) => workspace.id !== parsed.data.workspace.id),
      ]);
      applyWorkspaceSnapshot(parsed.data);
      if (imported.localEnvironment !== null) {
        setLocalEnvironmentWorkspaceId(parsed.data.workspace.id);
        setLocalEnvironmentContent(imported.localEnvironment);
      }
      resetProjectConversation();
      setStatus("Ready");
      setWorkspaceStatus("Project imported");
      setError(environmentError);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "The ZIP project could not be imported.");
    } finally {
      setZipImporting(false);
    }
  }, [
    applyWorkspaceSnapshot,
    flushWorkspaceSave,
    resetProjectConversation,
    zipImporting,
  ]);

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
      setFiles(isolateWorkspaceFiles(parsed.data.workspace.id, parsed.data.revision.files));
      setWorkspaceStatus("Saved");
    } catch (undoError) {
      setWorkspaceStatus("Needs attention");
      setError(undoError instanceof Error ? undoError.message : "Workspace undo failed.");
    }
  }, [isolateWorkspaceFiles, loading, workspaceId, workspaceParentRevisionId]);

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
    webContainerProcessesRef.current.forEach((process) => process.kill());
    webContainerProcessesRef.current.clear();
    webContainerPreviewProcessRef.current = null;
    webContainerRuntimeRef.current = null;
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

  const startWebContainer = useCallback(async () => {
    if (!workspaceId || !workspaceRevisionId) {
      setError("Save or create a coding project before starting a WebContainer.");
      return;
    }
    if (webContainerReloadRequired) {
      setError("Reload Nexus Code before starting the WebContainer again.");
      return;
    }
    if (webContainerStatus === "starting") return;
    if (webContainerRuntimeRef.current && webContainerStatus !== "failed") {
      setError("The WebContainer is already started. Run commands in its terminal or stop the container first.");
      return;
    }
    setError(null);
    await workspaceSaveQueueRef.current;
    await stopWebContainerPreview();
    const generation = ++webContainerGenerationRef.current;
    webContainerReadyRef.current = false;
    setWebContainerLogs("[boot] Starting browser WebContainer...\n");
    setWebContainerStatus(CodingWebContainerStatusSchema.parse("starting"));
    setWorkspaceStatus("Starting WebContainer");
    setPreviewUrl("");
    setShowPreview(true);

    const appendTerminalLine = (line: string) => {
      setWebContainerLogs((current) => `${current}${current.endsWith("\n") ? "" : "\n"}${line}\n`.slice(-30_000));
    };

    try {
      if (workspaceId && livePreview) {
        const response = await fetch(`/api/coding/workspaces/${encodeURIComponent(workspaceId)}/previews/${encodeURIComponent(livePreview.id)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!response.ok) throw new Error("The previous isolated preview could not be stopped.");
        setLivePreview(null);
      }
      const secureContext = window.isSecureContext;
      const isolated = window.crossOriginIsolated;
      const sharedMemoryAvailable = typeof SharedArrayBuffer !== "undefined";
      appendTerminalLine(`[env] secure context: ${secureContext}; cross-origin isolated: ${isolated}; SharedArrayBuffer: ${sharedMemoryAvailable}`);
      if (!secureContext || !isolated || !sharedMemoryAvailable) {
        const embedded = window.self !== window.top;
        setWebContainerNeedsTopLevel(embedded);
        throw new Error(embedded
          ? "WebContainers need cross-origin isolation and SharedArrayBuffer. Open Nexus Code in a top-level tab with COOP/COEP headers."
          : "WebContainers need a secure, cross-origin-isolated page with SharedArrayBuffer. Check the COOP/COEP response headers.");
      }
      setWebContainerNeedsTopLevel(false);
      const runtime = await bootCodingWebContainer((stage) => appendTerminalLine(`[boot] ${stage}`));
      if (generation !== webContainerGenerationRef.current) return;
      appendTerminalLine(`[fs] Mounting ${editorFiles.length} project files...`);
      await withCodingWebContainerTimeout(
        runtime.mount(createCodingWebContainerFileTree(editorFiles)),
        45_000,
        "Mounting the project timed out after 45 seconds.",
      );
      if (generation !== webContainerGenerationRef.current) return;
      webContainerRuntimeRef.current = runtime;
      webContainerSyncedFilesRef.current = new Set(editorFiles.map((file) => file.name));
      appendTerminalLine("[fs] Project files mounted.");

      const readyUnsubscribe = runtime.on("server-ready", (port, url) => {
        const parsed = CodingWebContainerReadySchema.safeParse({ port, url });
        if (!parsed.success) {
          setError("The WebContainer announced an invalid preview address.");
          return;
        }
        if (generation !== webContainerGenerationRef.current) return;
        webContainerReadyRef.current = true;
        webContainerPreviewProcessRef.current = Array.from(webContainerProcessesRef.current).at(-1) ?? null;
        setWebContainerNeedsTopLevel(false);
        setPreviewUrl(parsed.data.url);
        setWebContainerTerminalCollapsed(true);
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("running"));
        setWorkspaceStatus(`App running on port ${parsed.data.port}`);
        appendTerminalLine(`[server] Ready on port ${parsed.data.port}: ${parsed.data.url}`);
      });
      const errorUnsubscribe = runtime.on("error", (runtimeError) => {
        if (generation !== webContainerGenerationRef.current) return;
        webContainerRuntimeRef.current = null;
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("failed"));
        setError(runtimeError.message || "The WebContainer runtime failed.");
        appendTerminalLine(`[runtime error] ${runtimeError.message || "The WebContainer runtime failed."}`);
      });
      webContainerUnsubscribeRef.current = () => {
        readyUnsubscribe();
        errorUnsubscribe();
      };
      setWebContainerStatus(CodingWebContainerStatusSchema.parse("ready"));
      setWorkspaceStatus("WebContainer ready");
      appendTerminalLine("[container] Ready. Enter a command to run in this project.");
    } catch (previewError) {
      if (generation !== webContainerGenerationRef.current) return;
      setWebContainerStatus(CodingWebContainerStatusSchema.parse("failed"));
      setWorkspaceStatus("WebContainer failed");
      const message = previewError instanceof Error ? previewError.message : "WebContainer preview could not start.";
      if (message.includes("did not respond within 90 seconds")) setWebContainerReloadRequired(true);
      setError(message);
      appendTerminalLine(`[error] ${message}`);
      webContainerProcessesRef.current.forEach((process) => process.kill());
      webContainerProcessesRef.current.clear();
    }
  }, [editorFiles, livePreview, stopWebContainerPreview, webContainerReloadRequired, webContainerStatus, workspaceId, workspaceRevisionId]);

  const runWebContainerCommand = useCallback(async () => {
    const runtime = webContainerRuntimeRef.current;
    if (!runtime || !["ready", "installing", "running"].includes(webContainerStatus)) {
      setError("Start the WebContainer before running a command.");
      return;
    }
    const parsedCommand = CodingWebContainerCommandSchema.safeParse(livePreviewCommand);
    if (!parsedCommand.success) {
      setError("Enter a command between 1 and 500 characters.");
      return;
    }
    const command = parsedCommand.data;
    const generation = webContainerGenerationRef.current;
    const commandRunsNpmInstall = /^\s*npm\s+(?:install|i)\b/.test(command);
    setError(null);
    setWebContainerLogs((current) => `${current}${current.endsWith("\n") ? "" : "\n"}$ ${command}\n`.slice(-30_000));
    if (commandRunsNpmInstall && !webContainerReadyRef.current) {
      setWebContainerStatus(CodingWebContainerStatusSchema.parse("installing"));
      setWorkspaceStatus("Installing project dependencies");
    } else if (!webContainerReadyRef.current) {
      setWorkspaceStatus("Running WebContainer command");
    }

    const consumeOutput = (process: WebContainerProcess) => {
      void process.output.pipeTo(new WritableStream<string>({
        write(chunk) {
          const parsedOutput = CodingWebContainerOutputSchema.safeParse(chunk);
          if (!parsedOutput.success) throw new Error("The WebContainer returned invalid terminal output.");
          if (generation !== webContainerGenerationRef.current) return;
          setWebContainerLogs((current) => `${current}${parsedOutput.data}`.slice(-30_000));
        },
      })).catch((outputError: unknown) => {
        if (generation === webContainerGenerationRef.current) {
          const message = outputError instanceof Error ? outputError.message : "WebContainer terminal output failed.";
          setError(message);
          setWebContainerLogs((current) => `${current}\n[terminal error] ${message}\n`.slice(-30_000));
        }
      });
    };

    try {
      const process = await withCodingWebContainerTimeout(
        runtime.spawn("jsh", ["-c", command], { terminal: { cols: 80, rows: 24 } }),
        30_000,
        "The command could not start within 30 seconds.",
      );
      if (generation !== webContainerGenerationRef.current) {
        process.kill();
        return;
      }
      webContainerProcessesRef.current.add(process);
      consumeOutput(process);
      void process.exit.then((exitCode) => {
        if (generation !== webContainerGenerationRef.current) return;
        webContainerProcessesRef.current.delete(process);
        setWebContainerLogs((current) => `${current}${current.endsWith("\n") ? "" : "\n"}[exit ${exitCode}] ${command}\n`.slice(-30_000));
        if (webContainerPreviewProcessRef.current === process) {
          webContainerPreviewProcessRef.current = null;
          webContainerReadyRef.current = false;
          setPreviewUrl("");
          setWebContainerStatus(CodingWebContainerStatusSchema.parse("ready"));
          setWorkspaceStatus("WebContainer ready");
        } else if (commandRunsNpmInstall && !webContainerReadyRef.current) {
          setWebContainerStatus(CodingWebContainerStatusSchema.parse("ready"));
          setWorkspaceStatus("WebContainer ready");
        }
        if (exitCode !== 0) {
          setError(`Command exited with code ${exitCode}: ${command}`);
        }
      }).catch((processError: unknown) => {
        if (generation !== webContainerGenerationRef.current) return;
        webContainerProcessesRef.current.delete(process);
        const message = processError instanceof Error ? processError.message : "The WebContainer command failed.";
        setError(message);
        setWebContainerLogs((current) => `${current}\n[process error] ${message}\n`.slice(-30_000));
        if (commandRunsNpmInstall && !webContainerReadyRef.current) {
          setWebContainerStatus(CodingWebContainerStatusSchema.parse("ready"));
        }
      });
    } catch (commandError) {
      if (generation !== webContainerGenerationRef.current) return;
      const message = commandError instanceof Error ? commandError.message : "The WebContainer command could not start.";
      setError(message);
      setWebContainerLogs((current) => `${current}\n[command error] ${message}\n`.slice(-30_000));
      if (commandRunsNpmInstall && !webContainerReadyRef.current) {
        setWebContainerStatus(CodingWebContainerStatusSchema.parse("ready"));
      }
    }
  }, [livePreviewCommand, webContainerStatus]);

  useEffect(() => {
    if (webContainerStatus !== "ready" && webContainerStatus !== "running" && webContainerStatus !== "installing") return;
    let cancelled = false;
    const nextFileNames = new Set(editorFiles.map((file) => file.name));
    webContainerSyncQueueRef.current = webContainerSyncQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        if (cancelled) return;
        const tree = createCodingWebContainerFileTree(editorFiles);
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
  }, [editorFiles, webContainerStatus]);

  const startLivePreview = useCallback(async () => {
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

  const send = useCallback(async (requestedQuery?: string, continueFromPartial = false) => {
    const typedQuery = (requestedQuery ?? input).trim();
    const query = typedQuery || (attachedImages.length > 0
      ? "Describe the attached image(s) and read any visible text."
      : "");
    if (!query || loading) return;
    voiceInstructionRef.current = query;
    workspaceChangeReasonRef.current = `Nexus Code: ${query.slice(0, 360)}`;
    workspaceChangeSourceRef.current = "agent";
    setLoading(true);
    setStatus("Nexus Code is working");
    setError(null);
    setContextScopeNotice(null);
    const userMessage: CodingStoredMessage = {
      id: `user-${Date.now()}`,
      role: "user",
      content: query,
      createdAt: new Date().toISOString(),
      fileNames: [...attachedFileNames, ...attachedImages.map((image) => image.name)],
    };
    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: CodingStoredMessage = {
      id: assistantId,
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      fileNames: [],
    };
    let content = "";
    const requestHistory = messages
      .filter((message): message is CodingStoredMessage & { role: "user" | "assistant" } => message.role !== "system")
      .slice(-20)
      .map((message) => ({
        role: message.role,
        content: message.content.slice(-MAX_CODING_HISTORY_MESSAGE_CHARACTERS),
      }));
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
          contextStrategy: focusedContextEnabled ? "focused" : "full",
          agent,
          workspaceId: workspaceId ?? undefined,
          revisionId: workspaceRevisionRef.current ?? undefined,
          history: requestHistory,
          files,
          images: attachedImages,
          attachedFileNames,
          workbench: {
            projectName: workspaceName,
            workspaceStatus,
            activeSurface: codingSurface,
            fileExplorerOpen: showFiles,
            previewPanelOpen: showPreview,
            selectedFileName,
            explorerPaths: files.map((file) => file.name),
            previewRuntime,
            runtimeStatus: previewRuntime === "webcontainer"
              ? webContainerStatus
              : livePreview?.status ?? "stopped",
            previewUrl: previewRuntime === "webcontainer"
              ? previewUrl || null
              : livePreview?.previewUrl ?? null,
            terminalOutput: previewRuntime === "webcontainer"
              ? webContainerLogs
              : "",
          },
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { error?: unknown } | null;
        throw new Error(typeof payload?.error === "string" ? payload.error : "Nexus Code could not answer.");
      }
      if (focusedContextEnabled) {
        const scope = CodingContextScopeHeaderSchema.safeParse(
          response.headers.get("X-Nexus-Context-Files"),
        );
        if (scope.success) {
          const [included, total] = scope.data.split("/").map(Number);
          if (included < total) {
            setContextScopeNotice(
              `Focused context sent ${included} of ${total} workspace files. If Nexus Code needs an omitted file, attach it or switch to Full Context.`,
            );
          }
        }
      }
      if (!response.body) throw new Error("Nexus Code returned no response stream.");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
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
        if (content) setError("Generation stopped. The displayed response may be incomplete.");
      } else {
        setStatus("Needs attention");
        setError(requestError instanceof Error ? requestError.message : "Nexus Code request failed.");
      }
      if (content) {
        content += CODING_PARTIAL_RESPONSE_MARKER;
        setMessages((current) => current.map((message) => (
          message.id === assistantId ? { ...message, content } : message
        )));
      } else {
        setMessages((current) => current.filter((message) => message.id !== assistantId));
      }
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  }, [
    agent,
    attachedFileNames,
    codingSurface,
    files,
    focusedContextEnabled,
    input,
    livePreview?.previewUrl,
    loading,
    messages,
    mode,
    previewRuntime,
    previewUrl,
    selectedFileName,
    showFiles,
    showPreview,
    speakAssistantResponse,
    syncGeneratedFiles,
    webContainerLogs,
    webContainerStatus,
    workspaceId,
    workspaceName,
    workspaceStatus,
  ]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const renderTreeNodes = (nodes: CodingTreeNode[], depth = 0): React.ReactNode[] => nodes.flatMap((node) => {
    const row = node.kind === "file" ? (
      <div key={node.path} className="flex min-h-12 items-center gap-1">
        <button
          type="button"
          onClick={() => {
            setSelectedFileName(node.path);
            setCodingSurface("editor");
            setShowFiles(false);
            setShowPreview(false);
          }}
          className={`flex min-h-12 min-w-0 flex-1 items-center gap-2 rounded-lg px-2 text-left text-xs ${selectedFileName === node.path ? "bg-cyan-500/15 text-cyan-200" : "text-slate-400 hover:bg-slate-800/70 hover:text-slate-200"}`}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
        >
          <span className="shrink-0 font-mono text-[10px] text-cyan-400">{node.name.includes(".") ? "{" : "·"}</span>
          <span className="min-w-0 truncate">{node.name}</span>
          {node.path === LOCAL_ENV_FILE_NAME && (
            <span className="shrink-0 rounded bg-emerald-500/10 px-1.5 py-0.5 text-[9px] font-bold uppercase text-emerald-300">local</span>
          )}
        </button>
        <button
          type="button"
          onClick={() => deleteWorkspacePath(node.path, "file")}
          className="min-h-12 min-w-12 shrink-0 rounded-lg text-base text-slate-500"
          aria-label={`Delete ${node.path}`}
          title={`Delete ${node.path}`}
        >
          ×
        </button>
      </div>
    ) : (
      <div key={node.path}>
        <div
          className="flex min-h-12 items-center gap-1"
        >
          <div
            className="flex min-h-12 min-w-0 flex-1 items-center gap-2 px-2 text-[10px] font-bold uppercase tracking-widest text-slate-500"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            <span className="text-amber-300">▾</span>
            <span className="truncate">{node.name}</span>
          </div>
          <button
            type="button"
            onClick={() => deleteWorkspacePath(node.path, "folder")}
            className="min-h-12 min-w-12 shrink-0 rounded-lg text-base text-slate-500"
            aria-label={`Delete folder ${node.path}`}
            title={`Delete folder ${node.path}`}
          >
            ×
          </button>
        </div>
        {renderTreeNodes(node.children, depth + 1)}
      </div>
    );
    return [row];
  });

  return (
    <section className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-cyan-500/20 bg-slate-950/70 shadow-panel" aria-label="Nexus Code workspace">
      <header className="relative z-20 shrink-0 border-b border-cyan-500/20 bg-slate-950/90 px-3 py-2 backdrop-blur sm:px-4">
        <div className="flex min-h-12 flex-wrap items-center justify-between gap-2">
          <h1 className="min-w-0 truncate text-base font-bold text-slate-100 sm:text-lg">Nexus Code</h1>
          <div className={`rounded-full border px-2 py-1 text-[10px] font-semibold ${loading ? "border-amber-400/40 text-amber-300" : "border-emerald-400/30 text-emerald-300"}`} aria-live="polite">
            {status}
          </div>
          <button
            type="button"
            onClick={() => setMobileActionsOpen((open) => !open)}
            aria-expanded={mobileActionsOpen}
            aria-controls="coding-workspace-actions"
            aria-label={mobileActionsOpen ? "Hide workspace actions" : "Show workspace actions"}
            className="flex min-h-12 min-w-12 items-center justify-center rounded-xl border border-slate-700 text-slate-200 lg:hidden"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className="h-6 w-6 fill-none stroke-current stroke-2">
              {mobileActionsOpen
                ? <path d="m6 6 12 12M18 6 6 18" strokeLinecap="round" />
                : <path d="M4 6h16M4 12h16M4 18h16" strokeLinecap="round" />}
            </svg>
          </button>
        </div>
        <div
          id="coding-workspace-actions"
          className={`${mobileActionsOpen ? "flex" : "hidden"} flex-col gap-1 lg:flex`}
        >
          <div className="flex min-h-12 flex-wrap items-center justify-end gap-1.5">
            <button
              type="button"
              onClick={() => void undoWorkspace()}
              disabled={!workspaceParentRevisionId || loading || !workspaceRevisionId}
              className="min-h-12 min-w-12 rounded-xl border border-slate-700 px-2 text-xs font-semibold text-slate-400 disabled:opacity-40"
            >
              Undo
            </button>
            <button
              type="button"
              onClick={showChatHistory ? () => setShowChatHistory(false) : showProjectChatHistory}
              disabled={!workspaceId || chatHistoryWorkspaceId !== workspaceId}
              aria-expanded={showChatHistory}
              className="min-h-12 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300 disabled:opacity-40"
            >
              {showChatHistory ? "Back to chat" : "History"}
            </button>
            <button
              type="button"
              onClick={startNewChat}
              disabled={!workspaceId || chatHistoryWorkspaceId !== workspaceId}
              className="min-h-12 rounded-xl bg-cyan-400 px-3 text-xs font-bold text-slate-950 disabled:opacity-40"
            >
              New chat
            </button>
          </div>
        <div className="flex min-h-12 flex-wrap items-center gap-2">
          <select
            value={workspaceId ?? ""}
            onChange={(event) => void openWorkspace(event.target.value)}
            disabled={loading || workspaces.length === 0}
            aria-label="Select coding project"
            className="min-h-12 min-w-36 max-w-[min(48vw,18rem)] flex-1 rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200 focus:border-cyan-400/60 focus:outline-none disabled:opacity-60"
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
            <span className="sm:hidden">New</span>
            <span className="hidden sm:inline">New project</span>
          </button>
          <button
            type="button"
            onClick={() => void deleteWorkspace()}
            disabled={loading || !workspaceId}
            className="min-h-12 shrink-0 rounded-xl border border-rose-400/40 px-3 text-xs font-semibold text-rose-200 disabled:opacity-40"
          >
            Delete
          </button>
          <span className="shrink-0 px-1 text-[10px] font-semibold text-slate-500" aria-live="polite">{workspaceStatus}</span>
          <button
            type="button"
            onClick={() => toggleWorkspacePanel("files")}
            aria-pressed={showFiles}
            className={`min-h-12 shrink-0 rounded-xl border px-3 text-xs font-semibold ${showFiles ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200" : "border-slate-700 text-slate-400"}`}
          >
            Explorer {files.length > 0 ? `(${files.length})` : ""}
          </button>
          <button
            type="button"
            onClick={() => toggleWorkspacePanel("preview")}
            aria-pressed={showPreview}
            className={`min-h-12 shrink-0 rounded-xl border px-3 text-xs font-semibold ${showPreview ? "border-violet-400/50 bg-violet-500/15 text-violet-200" : "border-slate-700 text-slate-400"}`}
          >
            Preview
          </button>
          <label className="sr-only" htmlFor="coding-deployment-kind">Hosting type</label>
          <select
            id="coding-deployment-kind"
            value={deploymentKind}
            onChange={(event) => {
              const selected = CodingDeploymentKindSchema.safeParse(event.target.value);
              if (selected.success) setDeploymentKind(selected.data);
            }}
            disabled={deploymentBusy || deploymentInProgress || codingDeploymentStatus === "active"}
            className="min-h-12 max-w-40 rounded-xl border border-cyan-400/30 bg-slate-950 px-2 text-base text-cyan-100 disabled:opacity-50"
          >
            <option value="static">Static site</option>
            <option value="fullstack" disabled={!fullstackDeploymentAvailable}>
              {fullstackDeploymentAvailable ? "Full-stack app" : "Full-stack app (unavailable)"}
            </option>
          </select>
          <button
            type="button"
            onClick={() => void deployCodingWorkspace()}
            disabled={deploymentBusy || deploymentInProgress || (deploymentKind === "fullstack" && !fullstackDeploymentAvailable) || !workspaceId || !workspaceRevisionId || !workspaceFilesAreSaved}
            className="min-h-12 shrink-0 rounded-xl bg-cyan-300 px-3 text-xs font-bold text-slate-950 disabled:opacity-40"
          >
            {deploymentBusy
              ? deploymentKind === "static"
                ? deploymentUploadStarted ? "Uploading…" : "Building…"
                : "Deploying…"
              : codingDeploymentStatus === "active" ? "Redeploy" : "Deploy"}
          </button>
          {deploymentBusy && deploymentKind === "static" && !deploymentUploadStarted && (
            <button
              type="button"
              onClick={() => staticDeploymentAbortRef.current?.abort()}
              className="min-h-12 shrink-0 rounded-xl border border-rose-400/40 px-3 text-xs font-semibold text-rose-200 lg:px-4"
            >
              Cancel
            </button>
          )}
          <details className="group relative shrink-0">
            <summary className="flex min-h-12 cursor-pointer list-none items-center rounded-xl border border-cyan-400/30 px-3 text-xs font-semibold text-cyan-200 [&::-webkit-details-marker]:hidden">
              {codingDeployment ? `Deployment · ${codingDeployment.status}` : "Deployment status"}
              <span className="ml-2 text-[10px] text-cyan-300/70" aria-hidden="true">⌄</span>
            </summary>
            <div className="absolute right-0 top-full z-50 mt-2 max-h-[min(70dvh,36rem)] w-[min(90vw,34rem)] overflow-y-auto rounded-2xl border border-cyan-500/30 bg-slate-950 p-3 shadow-2xl">
              <p className="text-xs font-semibold text-cyan-200">EpicGlobal hosting</p>
              <p className="mt-1 text-[10px] leading-4 text-slate-400">
                Static is for browser-only React apps. Full-stack sends source to EpicGlobal, which builds and runs the Node.js server on your existing Droplet; its package.json needs a start script and the server must listen on PORT. Full-stack needs the EpicGlobal API key, but no GitHub repository, Docker, or coding runner. Builds run with the same host permissions as EpicGlobal's existing Git deployments.
              </p>
              {deploymentKind === "fullstack" && !fullstackDeploymentAvailable && (
                <p className="mt-2 text-xs text-amber-200">Full-stack deployment is unavailable until the EpicGlobal API key is configured and full-stack hosting is enabled on the Nexus server.</p>
              )}
              {deploymentKind === "fullstack" && (
                <label className="mt-3 block space-y-2">
                  <span className="text-xs font-semibold text-slate-200">Runtime variables (optional)</span>
                  <textarea
                    value={deploymentEnvironmentText}
                    onChange={(event) => setDeploymentEnvironmentText(event.target.value)}
                    disabled={deploymentBusy || deploymentInProgress}
                    rows={4}
                    placeholder={"OPENAI_API_KEY=...\nR2_ACCESS_KEY_ID=..."}
                    className="min-h-24 w-full rounded-xl border border-slate-700 bg-slate-900 p-3 text-base text-slate-100 placeholder:text-slate-600 disabled:opacity-50 lg:min-h-32"
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="block text-[10px] leading-4 text-slate-400">
                    Use the names from .env.example, one KEY=value per line. Values become server-only runtime secrets and are not saved with workspace files. Never use VITE_, REACT_APP_, or NEXT_PUBLIC_ names for secrets or add a .env file.
                  </span>
                </label>
              )}
              {codingDeployment && (
                <div className="mt-3 space-y-2 text-xs text-slate-300">
                  <p>
                    <span className="text-slate-500">Status:</span>{" "}
                    {codingDeployment.status}{codingDeployment.phase ? ` · ${codingDeployment.phase}` : ""}
                  </p>
                  <p><span className="text-slate-500">Hosting:</span> {codingDeployment.kind === "static" ? "Static site" : "Full-stack app"}</p>
                  <p><span className="text-slate-500">Revision:</span> {codingDeployment.revisionId}</p>
                  {codingDeployment.url && (
                    <a
                      href={codingDeployment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-12 items-center text-cyan-200 underline"
                    >
                      Open deployed site
                    </a>
                  )}
                  {codingDeployment.status === "deploying" && !codingDeployment.url && codingDeployment.kind === "fullstack" && (
                    <p className="text-slate-400">EpicGlobal is applying this release. Wait for completion before cancelling or taking the site offline.</p>
                  )}
                  {codingDeployment.error && <p role="alert" className="text-rose-200">{codingDeployment.error}</p>}
                  {(codingDeployment.url || codingDeployment.runnerJobId || (codingDeployment.kind === "static" && deploymentInProgress))
                    && codingDeployment.status !== "stopped"
                    && !(codingDeployment.status === "deploying" && !codingDeployment.url && codingDeployment.kind === "fullstack") && (
                    <button
                      type="button"
                      onClick={() => void stopCodingDeployment()}
                      className="min-h-12 rounded-xl border border-rose-400/40 px-3 text-xs font-semibold text-rose-200"
                    >
                      {codingDeployment.url ? "Take site offline" : "Cancel deployment"}
                    </button>
                  )}
                  {codingDeployment.logs && (
                    <pre className="max-h-[30dvh] overflow-auto rounded-xl border border-slate-800 bg-slate-900 p-3 text-[10px] leading-4 text-slate-300">
                      {codingDeployment.logs}
                    </pre>
                  )}
                </div>
              )}
              {(deploymentBusy || deploymentBuildLogs) && (
                <div className="mt-3 space-y-2">
                  {deploymentProgress && <p className="text-xs text-cyan-100 lg:text-sm" aria-live="polite">{deploymentProgress}</p>}
                  {deploymentBuildLogs && (
                    <pre className="max-h-[30dvh] overflow-auto rounded-xl border border-slate-800 bg-slate-900 p-3 text-[10px] leading-4 text-slate-300 lg:max-h-[35dvh]">
                      {deploymentBuildLogs}
                    </pre>
                  )}
                </div>
              )}
              {deploymentError && <p role="alert" className="mt-3 text-xs text-rose-200">{deploymentError}</p>}
            </div>
          </details>
          <details className="group relative shrink-0">
            <summary className="flex min-h-12 cursor-pointer list-none items-center rounded-xl border border-violet-400/30 px-3 text-xs font-semibold text-violet-200 [&::-webkit-details-marker]:hidden">
              Export / GitHub
              <span className="ml-2 text-[10px] text-violet-300/70" aria-hidden="true">⌄</span>
            </summary>
            <div className="absolute right-0 top-full z-50 mt-2 max-h-[min(70dvh,36rem)] w-[min(90vw,34rem)] overflow-y-auto rounded-2xl border border-violet-500/30 bg-slate-950 p-3 shadow-2xl">
              <p className="text-xs font-semibold text-violet-200">Export or publish this project</p>
              <p className="mt-1 text-[10px] leading-4 text-slate-400">
                GitHub uses broad repository permission for public and private repositories. Matching paths are overwritten; other files are kept.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => void exportWorkspaceZip()}
                  disabled={zipExporting || files.length === 0}
                  className="min-h-12 rounded-xl border border-cyan-400/40 px-3 text-xs font-semibold text-cyan-200 disabled:opacity-40"
                >
                  {zipExporting ? "Preparing ZIP…" : "Export ZIP"}
                </button>
                {githubConnected ? (
                  <button
                    type="button"
                    onClick={() => void disconnectGitHub()}
                    disabled={githubLoading}
                    className="min-h-12 rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300 disabled:opacity-40"
                  >
                    Disconnect {githubLogin ? `@${githubLogin}` : "GitHub"}
                  </button>
                ) : (
                  <a
                    href="/api/coding/github/connect"
                    aria-disabled={githubLoading}
                    className={`flex min-h-12 items-center rounded-xl bg-violet-300 px-3 text-xs font-bold text-slate-950 ${githubLoading ? "pointer-events-none opacity-40" : ""}`}
                  >
                    Connect GitHub
                  </a>
                )}
              </div>
              {githubConnected && (
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <label className="min-w-0 text-[10px] font-semibold text-slate-400">
                    Personal repository
                    <select
                      value={selectedGitHubRepository}
                      onChange={(event) => setSelectedGitHubRepository(event.target.value)}
                      disabled={githubLoading || githubRepositories.length === 0}
                      className="mt-1 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200 disabled:opacity-50"
                    >
                      {githubRepositories.length === 0 && <option value="">No owned repositories found</option>}
                      {githubRepositories.map((repository) => (
                        <option key={repository.fullName} value={repository.fullName}>
                          {repository.fullName}{repository.private ? " · private" : " · public"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="min-w-0 text-[10px] font-semibold text-slate-400">
                    Commit message
                    <input
                      value={githubCommitMessage}
                      onChange={(event) => setGithubCommitMessage(event.target.value)}
                      maxLength={200}
                      className="mt-1 min-h-12 w-full rounded-xl border border-slate-700 bg-slate-900 px-3 text-base text-slate-200"
                    />
                  </label>
                  <button
                    type="button"
                    onClick={() => void publishWorkspaceToGitHub()}
                    disabled={githubPublishing || githubLoading || !workspaceRevisionId || !workspaceFilesAreSaved || !selectedGitHubRepository || !githubCommitMessage.trim()}
                    className="min-h-12 rounded-xl bg-violet-300 px-4 text-xs font-bold text-slate-950 disabled:opacity-40 sm:col-span-2"
                  >
                    {githubPublishing ? "Publishing…" : "Publish to GitHub"}
                  </button>
                </div>
              )}
              {githubConnected && !workspaceFilesAreSaved && (
                <p className="mt-2 text-[10px] text-amber-200">Project edits are saving. Publishing will be available when they are saved.</p>
              )}
              {githubError && <p role="alert" className="mt-2 text-xs text-rose-200">{githubError}</p>}
              {githubNotice && (
                <p role="status" className="mt-2 text-xs text-emerald-200">
                  {githubNotice}
                  {githubCommitUrl && (
                    <>{" "}<a href={githubCommitUrl} target="_blank" rel="noopener noreferrer" className="underline">View commit</a></>
                  )}
                </p>
              )}
            </div>
          </details>
        </div>
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
          <div className="grid shrink-0 grid-cols-2 gap-2 border-b border-slate-800 p-3">
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
            <input
              ref={zipImportInputRef}
              type="file"
              accept=".zip,application/zip"
              className="hidden"
              onChange={(event) => {
                void importWorkspaceZip(event.target.files?.[0] ?? null);
                event.target.value = "";
              }}
            />
            <button type="button" onClick={() => folderInputRef.current?.click()} className="min-h-12 rounded-xl bg-cyan-400 px-3 text-xs font-bold text-slate-950">
              Open folder
            </button>
            <button
              type="button"
              onClick={() => createWorkspaceFile()}
              disabled={!workspaceId}
              className="min-h-12 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-40"
            >
              New file
            </button>
            <button
              type="button"
              onClick={() => createWorkspaceFile(LOCAL_ENV_FILE_NAME)}
              disabled={!workspaceId}
              className="min-h-12 rounded-xl border border-emerald-500/30 px-3 text-xs font-bold text-emerald-200 disabled:opacity-40"
            >
              New .env.local
            </button>
            <button
              type="button"
              onClick={() => zipImportInputRef.current?.click()}
              disabled={zipImporting}
              className="min-h-12 rounded-xl border border-slate-700 px-3 text-xs font-bold text-slate-200 disabled:opacity-40"
            >
              {zipImporting ? "Uploading…" : "Upload ZIP"}
            </button>
            <button
              type="button"
              onClick={() => void exportWorkspaceZip()}
              disabled={zipExporting || files.length === 0}
              className="min-h-12 rounded-xl border border-violet-400/30 px-3 text-xs font-bold text-violet-200 disabled:opacity-40"
            >
              {zipExporting ? "Preparing…" : "Download ZIP"}
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2" style={{ WebkitOverflowScrolling: "touch" }}>
            {fileTree.length > 0 && renderTreeNodes(fileTree)}
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
            showChatHistory ? (
              <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 lg:px-8" style={{ WebkitOverflowScrolling: "touch" }}>
                <div className="mx-auto w-full max-w-4xl">
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h2 className="text-base font-bold text-slate-100">Chat history</h2>
                      <p className="mt-1 text-xs text-slate-500">Saved in this browser for {workspaceName}</p>
                    </div>
                    <button
                      type="button"
                      onClick={startNewChat}
                      className="min-h-12 rounded-xl bg-cyan-400 px-4 text-xs font-bold text-slate-950"
                    >
                      New chat
                    </button>
                  </div>
                  <div className="grid gap-2" aria-label="Saved chats">
                    {chatThreads.map((thread) => {
                      const title = thread.title === "New chat"
                        ? codingChatThreadTitle(thread.messages)
                        : thread.title;
                      const updatedAt = Number.isFinite(Date.parse(thread.updatedAt))
                        ? new Date(thread.updatedAt).toLocaleString()
                        : "";
                      return (
                        <div key={thread.id} className="flex items-stretch gap-2">
                          <button
                            type="button"
                            onClick={() => openChatThread(thread.id)}
                            aria-pressed={thread.id === activeChatThreadId}
                            className="min-h-16 min-w-0 flex-1 rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-left"
                          >
                            <span className="flex items-center justify-between gap-3">
                              <span className="truncate text-sm font-semibold text-slate-200">{title}</span>
                              <span className="shrink-0 text-[10px] text-slate-500">
                                {thread.id === activeChatThreadId ? "Current" : updatedAt}
                              </span>
                            </span>
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteChatThread(thread.id)}
                            aria-label={`Delete chat: ${title}`}
                            title="Delete chat"
                            className="min-h-16 min-w-12 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 text-xs font-semibold text-rose-200"
                          >
                            Delete
                          </button>
                        </div>
                      );
                    })}
                  </div>
                  <p className="mt-4 text-[10px] leading-4 text-slate-600">
                    Chats are kept separately for each project in this browser. The latest 20 chats are retained.
                  </p>
                </div>
              </div>
            ) : (
              <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5 lg:px-8" style={{ WebkitOverflowScrolling: "touch" }}>
                <div className={`mx-auto flex min-h-full w-full max-w-5xl flex-col gap-4 ${messages.every((message) => message.role === "system") ? "justify-center" : "justify-end"}`}>
                  {messages.filter((message) => message.role !== "system").map((message) => (
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
                      {message.role === "assistant" && message.content.includes(CODING_PARTIAL_RESPONSE_MARKER) && (
                        <button
                          type="button"
                          disabled={loading}
                          onClick={() => void send(
                            "Continue the immediately preceding Nexus Code response from exactly where it stopped. Use the previous user request and the assistant's partial response in the conversation history. Do not restart, repeat, or summarize completed content; continue in the same format and finish the remaining requested work.",
                            true,
                          )}
                          className="mt-3 min-h-12 rounded-xl border border-cyan-500/40 bg-cyan-500/10 px-4 text-sm font-semibold text-cyan-200 disabled:opacity-50"
                        >
                          Continue response
                        </button>
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
            )
          ) : (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950/60">
              {selectedFile ? (
                <>
                  <div className="flex min-h-12 shrink-0 items-center justify-between gap-3 border-b border-slate-800 px-4">
                    <span className="truncate font-mono text-xs text-slate-400">{selectedFile.name}</span>
                    <span className="shrink-0 text-[10px] font-semibold uppercase tracking-widest text-slate-600">{selectedFile.language ?? "text"}</span>
                  </div>
                  <div className="flex min-h-0 flex-1 overflow-hidden">
                    <div
                      ref={lineNumberGutterRef}
                      aria-hidden="true"
                      className="min-h-0 shrink-0 overflow-hidden border-r border-slate-800 bg-slate-950/40 px-2 py-4 text-right font-mono text-base leading-6 text-slate-600 sm:px-3"
                    >
                      <div style={{ minWidth: `${Math.max(3, String(editorLineNumbers.length).length)}ch` }}>
                        {editorLineNumbers.map((_, index) => (
                          <div key={index} className="h-6">{index + 1}</div>
                        ))}
                      </div>
                    </div>
                  <textarea
                    ref={selectedFileEditorRef}
                    value={selectedFile.content}
                    onChange={(event) => updateSelectedFile(event.target.value)}
                    onScroll={(event) => {
                      if (lineNumberGutterRef.current) {
                        lineNumberGutterRef.current.scrollTop = event.currentTarget.scrollTop;
                      }
                    }}
                    aria-label={`Edit ${selectedFile.name}`}
                    spellCheck={false}
                    wrap="off"
                    className="min-h-0 min-w-0 flex-1 resize-none overflow-auto whitespace-pre bg-transparent px-4 py-4 font-mono text-base leading-6 text-slate-300 focus:outline-none"
                  />
                  </div>
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
          <div className="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2">
            <p role="alert" className="text-xs text-rose-200">{error || voiceError}</p>
            {webContainerNeedsTopLevel && (
              <div className="mt-2 flex flex-wrap gap-2">
                <a
                  href="/coding"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex min-h-12 items-center rounded-lg bg-rose-200 px-3 text-xs font-bold text-slate-950"
                >
                  Open Nexus Code in a new tab
                </a>
                <a
                  href="/coding"
                  target="_top"
                  className="flex min-h-12 items-center rounded-lg border border-rose-200/40 px-3 text-xs font-bold text-rose-100"
                >
                  Open in this tab
                </a>
              </div>
            )}
          </div>
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
          <input
            ref={imageInputRef}
            type="file"
            accept={CODING_IMAGE_MEDIA_TYPES.join(",")}
            multiple
            className="hidden"
            onChange={(event) => {
              void addImages(event.target.files);
              event.target.value = "";
            }}
          />
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (showChatHistory) return;
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={loading || showChatHistory}
            rows={2}
            placeholder={showChatHistory ? "Choose a chat or start a new one from history…" : "Describe the feature, bug, or code you want Nexus to work on…"}
            className="min-h-16 w-full resize-none border-0 bg-transparent px-2 py-2 text-base leading-6 text-slate-100 placeholder:text-slate-600 focus:outline-none disabled:opacity-50 sm:min-h-20"
          />
          {attachedFileNames.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-slate-800 px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {attachedFileNames.map((fileName) => (
                <button key={fileName} type="button" onClick={() => setAttachedFileNames((current) => current.filter((name) => name !== fileName))} disabled={showChatHistory} className="min-h-12 max-w-48 shrink-0 truncate rounded-xl border border-cyan-500/25 bg-cyan-500/10 px-3 text-xs text-cyan-200 disabled:opacity-40">
                  {fileName} ×
                </button>
              ))}
            </div>
          )}
          {attachedImages.length > 0 && (
            <div className="flex items-center gap-2 overflow-x-auto border-t border-slate-800 px-2 pt-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Attached images">
              {attachedImages.map((image, index) => (
                <div key={`${image.name}-${index}`} className="flex min-h-12 shrink-0 items-center gap-2 rounded-xl border border-violet-400/30 bg-violet-500/10 pl-1.5 pr-1 text-xs text-violet-100">
                  <Image
                    src={`data:${image.mediaType};base64,${image.data}`}
                    alt={`Attached image: ${image.name}`}
                    width={40}
                    height={40}
                    unoptimized
                    className="h-10 w-10 rounded-lg object-cover"
                  />
                  <span className="max-w-40 truncate">{image.name}</span>
                  <button
                    type="button"
                    onClick={() => setAttachedImages((current) => current.filter((_, currentIndex) => currentIndex !== index))}
                    disabled={loading || showChatHistory}
                    aria-label={`Remove image ${image.name}`}
                    className="min-h-12 min-w-12 rounded-lg text-base text-violet-200 disabled:opacity-40"
                  >
                    ×
                  </button>
                </div>
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
                disabled={showChatHistory}
                className={`min-h-12 shrink-0 rounded-xl border px-3 text-xs font-bold disabled:opacity-40 ${mode === item ? "border-cyan-400/50 bg-cyan-500/15 text-cyan-200" : "border-slate-700 bg-slate-950/70 text-slate-400"}`}
                aria-label={`${CODING_MODE_LABELS[item].label} mode`}
              >
                {CODING_MODE_LABELS[item].label}
              </button>
            ))}
            <button
              type="button"
              role="switch"
              aria-checked={focusedContextEnabled}
              onClick={() => {
                setFocusedContextEnabled((current) => !current);
                setContextScopeNotice(null);
              }}
              disabled={showChatHistory || loading}
              aria-label={focusedContextEnabled ? "Use full workspace context" : "Use focused workspace context"}
              title="Focused context selects likely relevant files and recent history. Switch off for the full workspace."
              className={`min-h-12 shrink-0 rounded-xl border px-3 text-xs font-bold disabled:opacity-40 ${focusedContextEnabled ? "border-amber-400/50 bg-amber-500/10 text-amber-200" : "border-slate-700 bg-slate-950/70 text-slate-400"}`}
            >
              {focusedContextEnabled ? "Focused context" : "Full context"}
            </button>
            <select
              value={agent}
              onChange={(event) => setAgent(CodingAgentSchema.parse(event.target.value))}
              disabled={showChatHistory}
              aria-label="DeepSeek coding model"
              className="min-h-12 min-w-[6.5rem] shrink-0 rounded-xl border border-slate-700 bg-slate-950/70 px-2 text-base text-slate-300 focus:border-violet-400/60 focus:outline-none disabled:opacity-40"
            >
              <option value="deepseek-chat" disabled={attachedImages.length > 0}>Chat</option>
              <option value="deepseek-reasoner" disabled={attachedImages.length > 0}>R1</option>
              <option value="deepseek-flash">Vision</option>
            </select>
            <button type="button" onClick={() => fileInputRef.current?.click()} disabled={showChatHistory} className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-xl border border-slate-700 bg-slate-950/70 text-lg text-slate-300 disabled:opacity-40" aria-label="Attach code">
              +
            </button>
            <button type="button" onClick={() => imageInputRef.current?.click()} disabled={loading || showChatHistory} className="flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-xl border border-violet-400/30 bg-slate-950/70 text-violet-200 disabled:opacity-40" aria-label="Attach image" title="Attach JPEG, PNG, GIF, or WebP">
              <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 fill-none stroke-current stroke-2">
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <circle cx="8.5" cy="9" r="1.5" />
                <path d="m21 15-5-5L5 20" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              role="switch"
              aria-checked={voiceModeEnabled}
              onClick={toggleVoiceMode}
              disabled={showChatHistory}
              aria-label={voiceModeEnabled ? "Turn Nexus voice mode off" : "Turn Nexus voice mode on"}
              title={voiceModeEnabled ? voiceStatusLabel(voiceStatus) : "Turn on Nexus voice mode"}
              className={`relative flex min-h-12 min-w-12 shrink-0 items-center justify-center rounded-xl border text-xs font-semibold disabled:opacity-40 ${voiceModeEnabled ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-200" : "border-slate-700 text-slate-400"}`}
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
              disabled={showChatHistory || (!loading && !input.trim() && attachedImages.length === 0)}
              className={`ml-auto min-h-12 shrink-0 rounded-xl px-4 text-sm font-bold ${loading ? "border border-rose-400/40 bg-rose-500/10 text-rose-200" : "bg-cyan-400 text-slate-950 disabled:bg-slate-700 disabled:text-slate-500"}`}
              aria-label={loading ? "Stop response" : "Send coding request"}
            >
              {loading ? "Stop" : "Send"}
            </button>
          </div>
        </div>
        <p className="mt-2 text-[10px] text-slate-600">
          Ctrl/⌘ + Enter to send · {focusedContextEnabled
            ? "Focused context may omit files; switch to Full Context or attach files if needed."
            : "Full Context sends the entire workspace, recent chat, and attached files."}
        </p>
        {contextScopeNotice && (
          <p role="status" className="mt-1 text-[10px] text-amber-300">
            {contextScopeNotice}
          </p>
        )}
        <p className="mt-1 text-[10px] text-slate-600">
          Each message sends project files, up to 20 prior chat messages, the active file and view
          {previewRuntime === "webcontainer" ? ", and recent WebContainer terminal output" : ""}
          {" to the selected AI provider."}
        </p>
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
                      ? "Start the container once, then run commands such as npm install and npm run dev."
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
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && previewRuntime === "webcontainer") {
                      event.preventDefault();
                      void runWebContainerCommand();
                    }
                  }}
                  aria-label={previewRuntime === "webcontainer" ? "WebContainer command" : "Live preview command"}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-3 text-base text-slate-200 focus:border-violet-400/60 focus:outline-none"
                  placeholder={previewRuntime === "webcontainer" ? "npm install or npm run dev" : "npm run dev"}
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
                {previewRuntime === "webcontainer" && webContainerReloadRequired ? (
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="min-h-12 rounded-lg border border-amber-400/40 px-3 text-xs font-semibold text-amber-200"
                  >
                    Reload page
                  </button>
                ) : (previewRuntime === "webcontainer"
                  ? webContainerStatus === "starting" || webContainerStatus === "installing" || webContainerStatus === "ready" || webContainerStatus === "running"
                  : Boolean(livePreview && livePreview.status !== "stopped" && livePreview.status !== "failed")) ? (
                  <button
                    type="button"
                    onClick={() => void (previewRuntime === "webcontainer" ? stopWebContainerPreview() : stopLivePreview())}
                    className="min-h-12 rounded-lg border border-rose-400/40 px-3 text-xs font-semibold text-rose-200"
                  >
                    {previewRuntime === "webcontainer" ? "Stop container" : "Stop"}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => void (previewRuntime === "webcontainer" ? startWebContainer() : startLivePreview())}
                    className="min-h-12 rounded-lg bg-violet-400 px-3 text-xs font-bold text-slate-950"
                  >
                    {previewRuntime === "webcontainer" ? "Start container" : "Start"}
                  </button>
                )}
                {previewRuntime === "webcontainer" && (
                  <button
                    type="button"
                    onClick={() => void runWebContainerCommand()}
                    disabled={!["ready", "installing", "running"].includes(webContainerStatus)}
                    className="min-h-12 rounded-lg bg-emerald-400 px-3 text-xs font-bold text-slate-950 disabled:bg-slate-700 disabled:text-slate-500"
                  >
                    Run
                  </button>
                )}
              </div>
              {previewRuntime === "webcontainer" && webContainerStatus !== "stopped" && (
                <>
                  <p className="mt-2 text-[10px] text-violet-300" aria-live="polite">
                    {webContainerStatus === "installing"
                      ? "Installing dependencies..."
                      : webContainerStatus === "ready"
                        ? "Container ready. Run commands whenever you need."
                        : `WebContainer ${webContainerStatus}.`}
                  </p>
                  <div className="mt-2 overflow-hidden rounded-lg border border-emerald-500/20 bg-[#030806]">
                    <div className="flex min-h-10 items-center justify-between border-b border-emerald-500/15 px-3 text-[10px] font-semibold uppercase tracking-widest text-emerald-300">
                      <span>Terminal</span>
                      <div className="flex items-center gap-3">
                        <span>{webContainerStatus}</span>
                        <button
                          type="button"
                          onClick={() => setWebContainerTerminalCollapsed((collapsed) => !collapsed)}
                          aria-expanded={!webContainerTerminalCollapsed}
                          className="min-h-10 px-2 text-[10px] font-semibold text-emerald-100"
                        >
                          {webContainerTerminalCollapsed ? "Show output" : "Hide output"}
                        </button>
                      </div>
                    </div>
                    {!webContainerTerminalCollapsed && (
                      <pre
                        ref={webContainerTerminalRef}
                        role="log"
                        aria-label="WebContainer terminal output"
                        aria-live="polite"
                        className="max-h-[30dvh] min-h-20 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[11px] leading-5 text-emerald-100"
                      >
                        {webContainerLogs || "Waiting for WebContainer output..."}
                      </pre>
                    )}
                  </div>
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
                  <a href={previewUrl} target="_blank" rel="opener" className="inline-flex min-h-12 items-center justify-center rounded-xl border border-slate-700 px-3 text-xs font-semibold text-slate-300">
                    New tab
                  </a>
                )}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3" style={{ WebkitOverflowScrolling: "touch" }}>
            {previewUrl && previewRuntime === "webcontainer" && (
              <div className="mb-3 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-xs leading-5 text-amber-100">
                If the preview says it needs third-party cookies, the browser is blocking its WebContainer service worker. iPad Safari may block this cross-site preview; try opening it in a desktop browser or use the Isolated runner.
              </div>
            )}
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
