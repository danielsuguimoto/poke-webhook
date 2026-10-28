import type { SourceHandler } from "./index";
import { agentmail } from "./sources/agentmail";
import { anakin } from "./sources/anakin";
import { circleback } from "./sources/circleback";
import { composio } from "./sources/composio";
import { goalApi } from "./sources/goal-api";
import { locationTracker } from "./sources/location-tracker";
import { parallel } from "./sources/parallel";
import { pluggy } from "./sources/pluggy";
import { ramble } from "./sources/ramble";
import { resend } from "./sources/resend";
import { tinyfish } from "./sources/tinyfish";
import { todoist } from "./sources/todoist";

export const SOURCES: Record<string, SourceHandler> = {
  "agentmail": agentmail,
  "anakin": anakin,
  "circleback": circleback,
  "composio": composio,
  "goal-api": goalApi,
  "location-tracker": locationTracker,
  "parallel": parallel,
  "pluggy": pluggy,
  "ramble": ramble,
  "resend": resend,
  "tinyfish": tinyfish,
  "todoist": todoist,
};
