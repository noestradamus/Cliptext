/** Only used by the local server build. Loopback/session authorization is
 * performed at the HTTP boundary before any existing library route is called.
 */
export type ChatGPTUser = { userId: string; displayName: string; email: string; fullName: string | null };
const localUser: Readonly<ChatGPTUser> = Object.freeze({ userId: 'local-owner', displayName: 'Local library', email: '', fullName: null });
export async function getChatGPTUser(): Promise<ChatGPTUser> { return { ...localUser }; }
export async function requireChatGPTUser(_returnTo = '/'): Promise<ChatGPTUser> { return { ...localUser }; }
export function chatGPTSignInPath(_returnTo = '/') { return '/'; }
export function chatGPTSignOutPath(_returnTo = '/') { return '/'; }
