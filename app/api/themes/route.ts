import { api, body, json, owner, sameOrigin } from '../../../lib/server';
import { activateTheme, createTheme, themeLibrary } from '../../../lib/theme-store';

export const dynamic = 'force-dynamic';

export async function GET() {
  return api(async () => json(await themeLibrary(await owner())));
}

export async function POST(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const ownerId = await owner();
    return json(await createTheme(ownerId, await body(request)), 201);
  });
}

export async function PATCH(request: Request) {
  return api(async () => {
    sameOrigin(request);
    const ownerId = await owner();
    const input = await body(request);
    return json(await activateTheme(ownerId, input.activeThemeId, input.activePresetId));
  });
}
