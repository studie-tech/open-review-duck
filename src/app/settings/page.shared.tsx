import { ArrowRight, Bot, PlugZap } from "lucide-react";
import Link from "next/link";
import { PageContainer } from "~/components/page-container";

const sections = [
  {
    href: "/settings/providers",
    title: "Code providers",
    body: "Connect GitHub, GitLab, and Azure DevOps repositories.",
    icon: PlugZap,
  },
  {
    href: "/settings/ai",
    title: "AI assistant",
    body: "Connect a supported model provider and configure assistance.",
    icon: Bot,
  },
];

/** Renders the settings page interface. */
export default function SettingsPage() {
  return (
    <PageContainer>
      <p className="text-lime text-xs font-semibold tracking-[.18em] uppercase">
        Workspace
      </p>
      <h1 className="font-editorial mt-3 text-4xl font-medium tracking-[-.04em]">
        Settings
      </h1>
      <p className="text-mist mt-2 text-sm">
        Configure the integrations behind your review workflow.
      </p>
      <div className="mt-9 grid gap-4 sm:grid-cols-2">
        {sections.map(({ href, title, body, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="group bg-surface/70 hover:bg-surface-hover flex items-center gap-4 rounded-2xl border border-line p-5 transition"
          >
            <span className="text-lime grid size-11 place-items-center rounded-xl bg-lime/10">
              <Icon className="size-5" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{title}</span>
              <span className="text-mist mt-1 block text-xs">{body}</span>
            </span>
            <ArrowRight className="text-fog group-hover:text-cloud size-4 transition group-hover:translate-x-1" />
          </Link>
        ))}
      </div>
    </PageContainer>
  );
}
