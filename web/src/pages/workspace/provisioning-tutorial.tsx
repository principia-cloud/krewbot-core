import { useEffect, useState } from 'react';
import {
  FolderOpen,
  BookOpen,
  Zap,
  Puzzle,
  Bot,
  MessageSquare,
  Loader2,
  CheckCircle2,
  ArrowRight,
  ArrowLeft,
  X,
  Sparkles,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useWorkspace } from './workspace-context';

interface TutorialSlide {
  icon: typeof FolderOpen;
  title: string;
  body: string;
  highlight?: string;
}

const SLIDES: TutorialSlide[] = [
  {
    icon: Sparkles,
    title: 'Welcome to your workspace',
    body: 'While we set things up in the background, take a quick tour of what your workspace can do. This usually takes 2–5 minutes.',
  },
  {
    icon: MessageSquare,
    title: 'Chat with your agent',
    body: 'Open the chat panel anytime to talk to your agent. Ask it to draft documents, run analyses, or fetch information from your connected tools. The agent has full access to your files, knowledge, and integrations.',
    highlight: 'Cmd/Ctrl + K opens the chat panel from anywhere.',
  },
  {
    icon: FolderOpen,
    title: 'Files',
    body: 'Every conversation creates files in a sandboxed workspace. You can browse, preview, and reference them in chat. The agent can read, write, and edit files just like a developer would.',
  },
  {
    icon: BookOpen,
    title: 'Knowledge',
    body: 'The Knowledge view holds your team\'s long-term context — rules, decisions, memory, and reference docs. The agent reads from these on every turn so it stays consistent across sessions.',
  },
  {
    icon: Bot,
    title: 'Agents',
    body: 'Build specialized sub-agents for focused jobs — a researcher, a writer, a code reviewer. Each one gets its own prompt, tools, and workspace, and your main agent can hand work off to them when it makes sense.',
  },
  {
    icon: Zap,
    title: 'Schedules',
    body: 'Schedule recurring tasks for the agent — daily standups, weekly reports, monitoring jobs. Just ask the agent in chat: "Send me a status report every weekday at 9 AM."',
  },
  {
    icon: Puzzle,
    title: 'Integrations',
    body: 'Connect Slack, Discord, WhatsApp, Telegram, Teams and more so your team can talk to the agent from the tools they already use. The agent receives messages from any platform and replies in the same thread.',
  },
];

export function ProvisioningTutorial({ onClose }: { onClose?: () => void }) {
  const { workspace } = useWorkspace();
  const [slide, setSlide] = useState(0);
  const isReady = workspace?.status === 'RUNNING';
  const isFailed = workspace?.status === 'FAILED' || workspace?.status === 'DELETING';

  // Auto-dismiss when ready (after a short victory beat)
  useEffect(() => {
    if (isReady && onClose) {
      const t = setTimeout(onClose, 2500);
      return () => clearTimeout(t);
    }
  }, [isReady, onClose]);

  const current = SLIDES[slide];
  const Icon = current.icon;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#0c1d36]/40 backdrop-blur-sm p-4">
      <div className="relative w-full max-w-lg rounded-[20px] border border-border bg-white shadow-[0_20px_60px_rgba(12,29,54,0.25)]">
        {/* Status banner */}
        <div className="flex items-center gap-2 rounded-t-[20px] border-b border-border bg-[#f5f7fa] px-5 py-3">
          {isReady ? (
            <>
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span className="text-sm font-medium text-emerald-700">
                Workspace ready!
              </span>
            </>
          ) : isFailed ? (
            <>
              <X className="h-4 w-4 text-red-600" />
              <span className="text-sm font-medium text-red-600">
                Provisioning failed
              </span>
            </>
          ) : (
            <>
              <Loader2 className="h-4 w-4 animate-spin text-[#2563eb]" />
              <span className="text-sm font-medium text-[#2563eb]">
                Provisioning your workspace…
              </span>
              <span className="ml-auto text-[11px] text-muted-foreground">
                Usually 2–5 minutes
              </span>
            </>
          )}
        </div>

        {/* Slide content */}
        <div className="px-7 py-8">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50">
            <Icon className="h-6 w-6 text-[#2563eb]" />
          </div>

          <h2 className="mb-2 text-xl font-semibold">{current.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {current.body}
          </p>

          {current.highlight && (
            <div className="mt-4 rounded-[10px] border border-[#2563eb]/20 bg-blue-50 px-3 py-2">
              <p className="text-xs text-[#2563eb]">{current.highlight}</p>
            </div>
          )}
        </div>

        {/* Footer with navigation + dots */}
        <div className="flex items-center justify-between rounded-b-[20px] border-t border-border bg-[#f5f7fa] px-5 py-3">
          <div className="flex items-center gap-1.5">
            {SLIDES.map((_, i) => (
              <button
                key={i}
                onClick={() => setSlide(i)}
                className={`h-1.5 rounded-full transition-all ${
                  i === slide
                    ? 'w-5 bg-[#0c1d36]'
                    : i < slide
                      ? 'w-1.5 bg-[#0c1d36]/40'
                      : 'w-1.5 bg-zinc-300'
                }`}
                aria-label={`Go to slide ${i + 1}`}
              />
            ))}
          </div>

          <div className="flex items-center gap-2">
            {slide > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSlide((s) => s - 1)}
                className="h-8 gap-1"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </Button>
            )}
            {slide < SLIDES.length - 1 ? (
              <Button
                size="sm"
                onClick={() => setSlide((s) => s + 1)}
                className="h-8 gap-1"
              >
                Next
                <ArrowRight className="h-3.5 w-3.5" />
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={onClose}
                className="h-8 gap-1"
                disabled={!isReady}
              >
                {isReady ? 'Get started' : 'Almost there…'}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
