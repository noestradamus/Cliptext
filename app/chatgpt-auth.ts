// Compatibility import for shared routes; no external account is used locally.
export {
  getChatGPTUser,
  requireChatGPTUser,
  chatGPTSignInPath,
  chatGPTSignOutPath,
} from '../local-app/server/auth';
export type { ChatGPTUser } from '../local-app/server/auth';
