import { api, body, json, owner, sameOrigin } from '../../../../lib/server';
import { deleteTheme, updateTheme } from '../../../../lib/theme-store';

export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const ownerId = await owner();
    return json(await updateTheme(ownerId, (await context.params).id, await body(request)));
  });
}

export async function DELETE(request: Request, context: Context) {
  return api(async () => {
    sameOrigin(request);
    const ownerId = await owner();
    return json(await deleteTheme(ownerId, (await context.params).id));
  });
}
