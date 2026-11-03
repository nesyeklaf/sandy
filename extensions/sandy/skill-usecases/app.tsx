import { definePluginApp } from "@sandy-sdk/plugin-sdk/app";
import { AreasPage } from "./areas";
import { FlowsPage, FlowsSidebar, parseFlowId } from "./flows";
import { FLOW_POPUP_ID, FlowsPopup } from "./composer";
import { FLOW_MENU, FLOW_SLASH_MENU, FlowMenuLoader } from "./composer-menu";
import { PANEL_PATH } from "./shared";
import { parseSkillPath } from "./skill-route";
import { SkillsPage } from "./skills-editor";

function SkillUseCasesPanel({ subPath }: { subPath: string }) {
  const skillName = parseSkillPath(subPath);
  if (skillName !== undefined) return <SkillsPage skillName={skillName} />;
  const flowId = parseFlowId(subPath);
  return flowId === undefined ? <AreasPage /> : <FlowsPage flowId={flowId} />;
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "flows",
    banners: [{ id: "flow-menu-loader", component: FlowMenuLoader, chrome: "bare" }],
    experimental_menus: [FLOW_MENU, FLOW_SLASH_MENU],
    experimental_popups: [{ id: FLOW_POPUP_ID, label: "Flows", component: FlowsPopup }],
    plusMenu: [
      {
        id: "open-flows",
        label: "Flows",
        icon: "GitBranch",
        run: ({ composer }) => {
          composer.experimental_openPopup(FLOW_POPUP_ID);
        },
      },
    ],
  });
  app.slots.navPanel({
    id: "skills-by-use-case",
    title: "Skills by use case",
    icon: "LayoutGrid",
    path: PANEL_PATH,
    component: SkillUseCasesPanel,
    experimental_sidebar: FlowsSidebar,
  });
});
