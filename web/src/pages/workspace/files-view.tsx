import { useState, useEffect, useCallback } from 'react';
import {
  ChevronRight,
  File,
  Folder,
  Copy,
  Loader2,
  FileText,
  FolderOpen,
  Pencil,
  Save,
  X,
  Plus,
  Trash2,
} from 'lucide-react';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useWorkspace } from './workspace-context';
import { useSessionInbox } from '@/hooks/use-session-inbox';
import { WorkspaceApiError, type FileEntry, type FileContent } from '@/api/workspace-client';

/** Fallback poll interval for the file tree. The per-session inbox
 * (useSessionInbox) refreshes the tree the instant a turn or background
 * task writes files; this slow poll is only a safety net for when the
 * inbox SSE connection can't be established. */
const FILE_TREE_POLL_MS = 20_000;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getLanguage(name: string): string | undefined {
  const ext = name.split('.').pop()?.toLowerCase();
  const map: Record<string, string> = {
    js: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx',
    py: 'python', sh: 'bash', json: 'json', md: 'markdown',
    yml: 'yaml', yaml: 'yaml', css: 'css', html: 'html',
    sql: 'sql', rs: 'rust', go: 'go', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', rb: 'ruby',
  };
  return ext ? map[ext] : undefined;
}

function getFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase();
  if (ext === 'md') return '📄';
  if (['js', 'ts', 'tsx', 'jsx'].includes(ext || '')) return '⚡';
  if (['py'].includes(ext || '')) return '🐍';
  if (['json', 'yml', 'yaml'].includes(ext || '')) return '⚙️';
  if (['sh', 'bash'].includes(ext || '')) return '🖥️';
  return null;
}

function countFiles(entries: FileEntry[]): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.type === 'file') count++;
    if (entry.children) count += countFiles(entry.children);
  }
  return count;
}

function TreeItem({
  entry,
  depth,
  selectedPath,
  onFileClick,
  onRename,
  onDelete,
}: {
  entry: FileEntry;
  depth: number;
  selectedPath: string | null;
  onFileClick: (path: string) => void;
  onRename: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}) {
  const [expanded, setExpanded] = useState(depth === 0);
  const isSelected = entry.type === 'file' && entry.path === selectedPath;

  const actions = (
    <div className="hidden items-center gap-0.5 group-hover:flex">
      <button
        className="rounded p-1 text-muted-foreground hover:bg-zinc-200 hover:text-foreground"
        onClick={(e) => {
          e.stopPropagation();
          onRename(entry);
        }}
        title="Rename"
      >
        <Pencil className="h-3 w-3" />
      </button>
      <button
        className="rounded p-1 text-muted-foreground hover:bg-zinc-200 hover:text-red-600"
        onClick={(e) => {
          e.stopPropagation();
          onDelete(entry);
        }}
        title="Delete"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );

  if (entry.type === 'directory') {
    return (
      <div>
        <div
          className="group flex w-full items-center gap-1.5 rounded-md pr-1 text-sm hover:bg-white/70 transition-colors"
          style={{ paddingLeft: `${depth * 16 + 8}px` }}
        >
          <button
            className="flex flex-1 items-center gap-1.5 py-1.5 text-left"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronRight
              className={cn(
                'h-3.5 w-3.5 text-muted-foreground transition-transform',
                expanded && 'rotate-90',
              )}
            />
            {expanded ? (
              <FolderOpen className="h-4 w-4 text-[#2563eb]" />
            ) : (
              <Folder className="h-4 w-4 text-[#2563eb]" />
            )}
            <span className="truncate font-medium">{entry.name}</span>
          </button>
          {actions}
        </div>
        {expanded &&
          entry.children?.map((child) => (
            <TreeItem
              key={child.path}
              entry={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              onFileClick={onFileClick}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'group flex w-full items-center gap-1.5 rounded-md pr-1 text-sm transition-colors cursor-pointer',
        isSelected
          ? 'bg-white shadow-sm text-foreground'
          : 'text-muted-foreground hover:bg-white/70 hover:text-foreground',
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
      onClick={() => onFileClick(entry.path)}
    >
      <span className="w-3.5" />
      <File className="h-4 w-4 shrink-0" />
      <span className="truncate flex-1 py-1.5 text-left">{entry.name}</span>
      {entry.size !== undefined && (
        <span className="text-[11px] text-muted-foreground group-hover:hidden">
          {formatSize(entry.size)}
        </span>
      )}
      {actions}
    </div>
  );
}

export function FilesView() {
  const { client, activeSessionId, sessions } = useWorkspace();
  const [tree, setTree] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [selectedFileError, setSelectedFileError] = useState<
    { name: string; path: string; message: string } | null
  >(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [creatingNew, setCreatingNew] = useState(false);
  const [newPath, setNewPath] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Rename modal state. The browser-default prompt() was visually
  // jarring; surfacing it as a styled Dialog keeps the experience
  // consistent with the rest of the app.
  const [renameTarget, setRenameTarget] = useState<FileEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameSaving, setRenameSaving] = useState(false);

  // Delete confirmation modal state.
  const [deleteTarget, setDeleteTarget] = useState<FileEntry | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteSaving, setDeleteSaving] = useState(false);

  // Discard-unsaved-changes modal state. `onContinue` runs after the
  // user confirms — used for "switch file" and "cancel edit" flows.
  const [discardConfirm, setDiscardConfirm] = useState<
    { onContinue: () => void } | null
  >(null);

  const isDirty = editing && selectedFile !== null && editDraft !== selectedFile.content;

  const exitEdit = () => {
    setEditing(false);
    setEditDraft('');
    setSaveError(null);
  };

  const startEdit = () => {
    if (!selectedFile) return;
    setEditDraft(selectedFile.content);
    setSaveError(null);
    setEditing(true);
  };

  const cancelEdit = () => {
    if (isDirty) {
      setDiscardConfirm({ onContinue: exitEdit });
      return;
    }
    exitEdit();
  };

  const startCreateFile = () => {
    setNewPath('');
    setCreateError(null);
    setCreatingNew(true);
  };

  const cancelCreateFile = () => {
    setCreatingNew(false);
    setNewPath('');
    setCreateError(null);
  };

  const submitCreateFile = async () => {
    if (!activeSessionId || creating) return;
    const trimmed = newPath.trim().replace(/^\/+/, '');
    if (!trimmed) {
      setCreateError('Path is required');
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const created = await client.files.write(activeSessionId, trimmed, '');
      setCreatingNew(false);
      setNewPath('');
      await Promise.resolve();
      loadTree();
      setSelectedFile(created);
    } catch (err) {
      const message =
        err instanceof WorkspaceApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to create file';
      setCreateError(message);
    } finally {
      setCreating(false);
    }
  };

  const handleRename = (entry: FileEntry) => {
    setRenameTarget(entry);
    setRenameDraft(entry.path);
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!activeSessionId || !renameTarget || renameSaving) return;
    const trimmed = renameDraft.trim().replace(/^\/+/, '');
    if (!trimmed) {
      setRenameError('Path is required');
      return;
    }
    if (trimmed === renameTarget.path) {
      setRenameTarget(null);
      return;
    }
    setRenameSaving(true);
    setRenameError(null);
    try {
      await client.files.rename(activeSessionId, renameTarget.path, trimmed);
      // If the renamed entry was open, reload the new path so the
      // preview keeps up.
      if (
        selectedFile?.path === renameTarget.path &&
        renameTarget.type === 'file'
      ) {
        try {
          const fresh = await client.files.read(activeSessionId, trimmed);
          setSelectedFile(fresh);
        } catch {
          setSelectedFile(null);
        }
      }
      loadTree();
      setRenameTarget(null);
    } catch (err) {
      setRenameError(
        err instanceof WorkspaceApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to rename',
      );
    } finally {
      setRenameSaving(false);
    }
  };

  const handleDelete = (entry: FileEntry) => {
    setDeleteTarget(entry);
    setDeleteError(null);
  };

  const submitDelete = async () => {
    if (!activeSessionId || !deleteTarget || deleteSaving) return;
    setDeleteSaving(true);
    setDeleteError(null);
    try {
      await client.files.delete(activeSessionId, deleteTarget.path);
      if (
        selectedFile &&
        (selectedFile.path === deleteTarget.path ||
          selectedFile.path.startsWith(deleteTarget.path + '/'))
      ) {
        setSelectedFile(null);
        exitEdit();
      }
      loadTree();
      setDeleteTarget(null);
    } catch (err) {
      setDeleteError(
        err instanceof WorkspaceApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to delete',
      );
    } finally {
      setDeleteSaving(false);
    }
  };

  const saveEdit = async () => {
    if (!activeSessionId || !selectedFile || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await client.files.write(
        activeSessionId,
        selectedFile.path,
        editDraft,
      );
      setSelectedFile(updated);
      exitEdit();
      // Refresh the tree so the file size/mtime stay in sync.
      loadTree();
    } catch (err) {
      const message =
        err instanceof WorkspaceApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to save file';
      setSaveError(message);
    } finally {
      setSaving(false);
    }
  };

  const activeSession = activeSessionId
    ? sessions.find((s) => s.id === activeSessionId)
    : null;
  const sessionLabel =
    activeSession &&
    activeSession.name &&
    activeSession.name !== `chat-${activeSession.id}`
      ? activeSession.name
      : 'New chat';

  const loadTree = useCallback(() => {
    if (!activeSessionId) {
      setTree([]);
      setLoading(false);
      return;
    }
    client.files
      .list(activeSessionId)
      // Skip the state update when nothing changed so the background poll
      // below doesn't re-render the tree every tick.
      .then((next) =>
        setTree((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)),
      )
      .catch(() => setTree([]))
      .finally(() => setLoading(false));
  }, [activeSessionId, client]);

  useEffect(() => {
    setLoading(true);
    setSelectedFile(null);
    setSelectedFileError(null);
    loadTree();
  }, [activeSessionId, loadTree]);

  // Fallback poll of the file tree (paused when the tab is hidden), in case
  // the inbox SSE below can't connect. Instant refresh comes from the inbox.
  useEffect(() => {
    if (!activeSessionId) return;
    const timer = setInterval(() => {
      if (!document.hidden) loadTree();
    }, FILE_TREE_POLL_MS);
    return () => clearInterval(timer);
  }, [activeSessionId, loadTree]);

  // Instant refresh: the server pushes `files_changed` to the session inbox
  // after every turn and background task, so the tree updates the moment
  // files are written. On (re)connect the hook fires 'sync' → loadTree.
  const inboxUrl = activeSessionId
    ? `${client.baseUrl}/api/sessions/${activeSessionId}/inbox/stream`
    : null;
  useSessionInbox(inboxUrl, () => loadTree());

  const handleFileClick = async (filePath: string) => {
    if (!activeSessionId) return;
    if (isDirty) {
      // Defer the actual file load until the user confirms discard,
      // otherwise their edits are gone the moment they click.
      setDiscardConfirm({
        onContinue: () => {
          exitEdit();
          void loadFile(filePath);
        },
      });
      return;
    }
    exitEdit();
    await loadFile(filePath);
  };

  const loadFile = async (filePath: string) => {
    if (!activeSessionId) return;
    setFileLoading(true);
    setSelectedFileError(null);
    try {
      const content = await client.files.read(activeSessionId, filePath);
      setSelectedFile(content);
    } catch (err) {
      setSelectedFile(null);
      const name = filePath.split('/').pop() || filePath;
      const message =
        err instanceof WorkspaceApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to load file';
      setSelectedFileError({ name, path: filePath, message });
    } finally {
      setFileLoading(false);
    }
  };

  const handleCopyPath = () => {
    if (selectedFile) {
      navigator.clipboard.writeText(selectedFile.path);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  if (!activeSessionId) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <FolderOpen className="mx-auto mb-3 h-10 w-10 text-muted-foreground opacity-30" />
          <p className="text-sm text-muted-foreground">Select a session to browse files</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const fileCount = countFiles(tree);

  return (
    <div className="flex h-full">
      {/* File tree panel */}
      <div className="flex w-[240px] shrink-0 flex-col border-r border-border bg-[#f5f7fa]">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="text-sm font-medium">Files</span>
              <span className="truncate text-[10px] text-muted-foreground">
                {sessionLabel}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="whitespace-nowrap text-[11px] text-muted-foreground">
              {fileCount} file{fileCount !== 1 ? 's' : ''}
            </span>
            <button
              className="rounded p-1 text-muted-foreground hover:bg-zinc-100 hover:text-foreground"
              onClick={startCreateFile}
              title="New file"
              disabled={creatingNew}
            >
              <Plus className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
        {creatingNew && (
          <div className="border-b border-border bg-white/80 p-2">
            <input
              autoFocus
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitCreateFile();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelCreateFile();
                }
              }}
              placeholder="path/to/file.md"
              className="w-full rounded border border-border bg-white px-2 py-1 font-mono text-xs focus:border-accent focus:outline-none"
            />
            {createError && (
              <p className="mt-1 text-[11px] text-red-600">{createError}</p>
            )}
            <div className="mt-1.5 flex justify-end gap-1">
              <button
                className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                onClick={cancelCreateFile}
                disabled={creating}
              >
                Cancel
              </button>
              <button
                className="rounded bg-foreground px-2 py-0.5 text-[11px] text-white disabled:opacity-50"
                onClick={() => void submitCreateFile()}
                disabled={creating || !newPath.trim()}
              >
                {creating ? '…' : 'Create'}
              </button>
            </div>
          </div>
        )}
        <ScrollArea className="flex-1">
          <div className="p-1.5">
            {tree.length === 0 ? (
              <div className="flex flex-col items-center py-12 text-center">
                <FileText className="mb-2 h-8 w-8 text-muted-foreground opacity-30" />
                <p className="text-xs text-muted-foreground">No files yet</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Click the + above to create one, or ask the agent.
                </p>
              </div>
            ) : (
              tree.map((entry) => (
                <TreeItem
                  key={entry.path}
                  entry={entry}
                  depth={0}
                  selectedPath={selectedFile?.path ?? null}
                  onFileClick={handleFileClick}
                  onRename={handleRename}
                  onDelete={handleDelete}
                />
              ))
            )}
          </div>
        </ScrollArea>
      </div>

      {/* File content preview */}
      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
        {selectedFile ? (
          <>
            <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
              <div className="flex items-center gap-2 min-w-0">
                {getFileIcon(selectedFile.name) && (
                  <span className="text-sm">{getFileIcon(selectedFile.name)}</span>
                )}
                <span className="truncate text-sm font-mono font-medium">{selectedFile.name}</span>
                <span className="text-[11px] text-muted-foreground">
                  {(editing ? editDraft : selectedFile.content).split('\n').length} lines
                  {isDirty && ' · unsaved'}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {editing ? (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={cancelEdit}
                      disabled={saving}
                    >
                      <X className="h-3 w-3" />
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={saveEdit}
                      disabled={saving || !isDirty}
                    >
                      {saving ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Save className="h-3 w-3" />
                      )}
                      Save
                    </Button>
                  </>
                ) : (
                  <>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={handleCopyPath}
                    >
                      <Copy className="h-3 w-3" />
                      {copied ? 'Copied!' : 'Copy path'}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 gap-1.5 text-xs"
                      onClick={startEdit}
                    >
                      <Pencil className="h-3 w-3" />
                      Edit
                    </Button>
                  </>
                )}
              </div>
            </div>
            {saveError && (
              <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
                {saveError}
              </div>
            )}
            <div className="flex-1 overflow-auto">
              {editing ? (
                <textarea
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  spellCheck={false}
                  className="h-full w-full resize-none border-0 bg-white px-4 py-3 font-mono text-[13px] leading-[1.6] text-foreground focus:outline-none"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                      e.preventDefault();
                      void saveEdit();
                    }
                  }}
                />
              ) : (
                <SyntaxHighlighter
                  style={oneLight}
                  language={getLanguage(selectedFile.name)}
                  showLineNumbers
                  customStyle={{
                    margin: 0,
                    background: 'transparent',
                    fontSize: '0.8125rem',
                    lineHeight: '1.6',
                    padding: '12px 0',
                    overflow: 'visible',
                  }}
                  lineNumberStyle={{ color: '#94a3b8', minWidth: '3em', paddingRight: '1em' }}
                >
                  {selectedFile.content}
                </SyntaxHighlighter>
              )}
            </div>
          </>
        ) : selectedFileError ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#fef2f2]">
              <FileText className="h-7 w-7 text-red-500" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">
                Can't preview <span className="font-mono">{selectedFileError.name}</span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{selectedFileError.message}</p>
            </div>
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[#f5f7fa]">
              <FileText className="h-7 w-7 text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium text-muted-foreground">No file selected</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Choose a file from the tree to preview its contents
              </p>
            </div>
          </div>
        )}

        {fileLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-white/60 backdrop-blur-sm">
            <div className="flex items-center gap-2 rounded-lg bg-white px-4 py-2 shadow-md">
              <Loader2 className="h-4 w-4 animate-spin text-accent" />
              <span className="text-sm text-muted-foreground">Loading file...</span>
            </div>
          </div>
        )}
      </div>

      {/* Rename modal */}
      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => {
          if (!open && !renameSaving) {
            setRenameTarget(null);
            setRenameDraft('');
            setRenameError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Rename {renameTarget?.type === 'directory' ? 'folder' : 'file'}
            </DialogTitle>
            <DialogDescription>
              Path is relative to the chat's workdir. Move across folders by
              including a slash.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Input
              autoFocus
              value={renameDraft}
              onChange={(e) => setRenameDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void submitRename();
                }
              }}
              placeholder="path/to/file.md"
              className="font-mono text-sm"
            />
            {renameError && (
              <p className="mt-2 text-xs text-red-600">{renameError}</p>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setRenameTarget(null)}
              disabled={renameSaving}
            >
              Cancel
            </Button>
            <Button
              onClick={submitRename}
              disabled={
                renameSaving ||
                !renameDraft.trim() ||
                renameDraft.trim().replace(/^\/+/, '') === renameTarget?.path
              }
            >
              {renameSaving && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Rename
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation modal */}
      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteSaving) {
            setDeleteTarget(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Delete {deleteTarget?.type === 'directory' ? 'folder' : 'file'}?
            </DialogTitle>
            <DialogDescription>
              {deleteTarget?.type === 'directory'
                ? 'This folder and all its contents will be removed. This cannot be undone.'
                : 'This file will be permanently removed. This cannot be undone.'}
            </DialogDescription>
          </DialogHeader>
          {deleteTarget && (
            <div className="rounded-md bg-zinc-50 px-3 py-2 font-mono text-xs text-foreground">
              {deleteTarget.path}
            </div>
          )}
          {deleteError && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">
              {deleteError}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteSaving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={submitDelete}
              disabled={deleteSaving}
            >
              {deleteSaving && (
                <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
              )}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Discard unsaved changes modal */}
      <Dialog
        open={discardConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setDiscardConfirm(null);
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Discard unsaved changes?</DialogTitle>
            <DialogDescription>
              You have edits to{' '}
              <span className="font-mono">
                {selectedFile?.name ?? 'this file'}
              </span>{' '}
              that haven't been saved. Continuing will lose them.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline"
              onClick={() => setDiscardConfirm(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const cb = discardConfirm?.onContinue;
                setDiscardConfirm(null);
                cb?.();
              }}
            >
              Discard
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
