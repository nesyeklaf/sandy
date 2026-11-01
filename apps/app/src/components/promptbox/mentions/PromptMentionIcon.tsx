import type { PromptMentionResource } from "@sandy/domain";
import type { ComposerMentionTargetShape } from "@sandy/client-core";
import { Icon } from "@sandy/shared-ui/icon";
import { PluginItemIcon } from "@/components/plugin/PluginIcon";
import { promptMentionIconName } from "@sandy/client-core";
import { composerMentionResource } from "./prompt-mention-pill";

export function PromptMentionIcon({
  className,
  resource,
}: {
  className?: string;
  resource: PromptMentionResource;
}) {
  if (resource.kind === "plugin") {
    return (
      <PluginItemIcon
        pluginId={resource.pluginId}
        icon={resource.icon ?? null}
        className={className}
      />
    );
  }
  return (
    <Icon
      name={promptMentionIconName(resource)}
      className={className}
      aria-hidden
    />
  );
}

export function ComposerMentionIcon({
  mention,
  className,
}: {
  mention: ComposerMentionTargetShape;
  className?: string;
}) {
  return (
    <PromptMentionIcon
      resource={composerMentionResource(mention)}
      {...(className === undefined ? {} : { className })}
    />
  );
}
