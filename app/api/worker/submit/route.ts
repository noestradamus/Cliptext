import { api, body, engineRequest, json } from '../../../../lib/server';
import { submitJob } from '../../../../lib/submit';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  return api(async () => {
    engineRequest(request);
    const input = await body(request);
    return json({ job: await submitJob(input.url) }, 201);
  });
}
