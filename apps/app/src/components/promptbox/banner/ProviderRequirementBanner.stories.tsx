import { Button } from "@sandy/shared-ui/button";
import { StoryCard, StoryRow } from "../../../../.ladle/story-card";
import { ResponsiveStage } from "./banner-story-stages";
import { ProviderCliBanner } from "./ProviderCliBanner";
import { ProviderRequirementBanner } from "./ProviderRequirementBanner";
import {
  MACHINE_SERVER_ACCESS_TITLE,
  machineServerAccessBlockedReason,
} from "@/components/machines/machine-server-access";
import { TAILNET_SETUP_REQUIRED } from "../../../../.ladle/machine-story-fixtures";

export default {
  title: "promptbox/banner/Provider Requirement",
};

const noop = () => {};

function configureAction(displayName: string) {
  return (
    <Button
      type="button"
      size="sm"
      className="h-8 shrink-0 px-3"
      onClick={noop}
    >
      Configure {displayName}
    </Button>
  );
}

export function Requirements() {
  return (
    <StoryCard labelWidth="230px">
      <StoryRow
        label="environment needs configuring"
        hint="the provider's own setup-required message says what is missing; the title and action carry the rest"
      >
        <ResponsiveStage>
          <ProviderRequirementBanner
            title="Modal Sandbox needs configuration"
            description="Set tokenId and tokenSecret in the plugin's settings."
            action={configureAction("Modal Sandbox")}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="machines cannot reach sandy"
        hint="the environment would create a machine, but nothing tells that machine how to reach this server"
      >
        <ResponsiveStage>
          <ProviderRequirementBanner
            title={MACHINE_SERVER_ACCESS_TITLE}
            description={machineServerAccessBlockedReason(TAILNET_SETUP_REQUIRED)}
            action={
              <Button
                type="button"
                size="sm"
                className="h-8 shrink-0 px-3"
                onClick={noop}
              >
                Set up machine access
              </Button>
            }
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="provider CLI not installed"
        hint="the selected provider has no CLI on this machine"
      >
        <ResponsiveStage>
          <ProviderCliBanner
            displayName="Claude Code"
            installed={false}
            currentVersion={null}
            minimumSupportedVersion={null}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow label="provider CLI too old" hint="both versions are known">
        <ResponsiveStage>
          <ProviderCliBanner
            installed
            displayName="Codex"
            currentVersion="0.135.0"
            minimumSupportedVersion="0.136.0"
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="installed version unknown"
        hint="the machine did not report a version, so only the requirement is stated"
      >
        <ResponsiveStage>
          <ProviderCliBanner
            installed
            displayName="Cursor"
            currentVersion={null}
            minimumSupportedVersion="0.49.0"
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="required version unknown"
        hint="sandy knows the installed version is too old but not what it needs"
      >
        <ResponsiveStage>
          <ProviderCliBanner
            installed
            displayName="Cursor"
            currentVersion="0.48.2"
            minimumSupportedVersion={null}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="neither version known"
        hint="the last-resort copy, with nothing concrete to name"
      >
        <ResponsiveStage>
          <ProviderCliBanner
            installed
            displayName="Cursor"
            currentVersion={null}
            minimumSupportedVersion={null}
          />
        </ResponsiveStage>
      </StoryRow>
      <StoryRow
        label="a long provider name"
        hint="the title and action both carry the name, so the row has to survive a long one"
      >
        <ResponsiveStage>
          <ProviderRequirementBanner
            title="DigitalOcean development droplet needs configuration"
            description="Add a DigitalOcean API token in the plugin's settings."
            action={configureAction("DigitalOcean development droplet")}
          />
        </ResponsiveStage>
      </StoryRow>
    </StoryCard>
  );
}
