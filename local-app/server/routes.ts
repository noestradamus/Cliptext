import * as jobs from '../../app/api/jobs/route';
import * as batch from '../../app/api/jobs/batch/route';
import * as job from '../../app/api/jobs/[id]/route';
import * as frame from '../../app/api/jobs/[id]/frame/route';
import * as slide from '../../app/api/jobs/[id]/slides/[index]/route';
import * as library from '../../app/api/library/route';
import * as collections from '../../app/api/collections/route';
import * as collection from '../../app/api/collections/[id]/route';
import * as themes from '../../app/api/themes/route';
import * as theme from '../../app/api/themes/[id]/route';
import * as backup from '../../app/api/backup/route';
import * as exports from '../../app/api/export/route';
import * as heartbeat from '../../app/api/worker/heartbeat/route';
import * as submit from '../../app/api/worker/submit/route';
import * as claim from '../../app/api/worker/claim/route';
import * as result from '../../app/api/worker/jobs/[id]/route';
import * as identity from '../../app/api/worker/jobs/[id]/identity/route';
import * as uploadSlide from '../../app/api/worker/jobs/[id]/slides/[index]/route';
import * as frameClaim from '../../app/api/worker/frames/claim/route';
import * as frameResult from '../../app/api/worker/frames/[id]/route';
import * as insightClaim from '../../app/api/worker/insights/claim/route';
import * as insightResult from '../../app/api/worker/insights/[id]/route';
import * as slidesClaim from '../../app/api/worker/slides/claim/route';
import * as slidesResult from '../../app/api/worker/slides/[id]/route';

type Handler = (request: Request, context: { params: Promise<Record<string, string>> }) => Promise<Response>;
type RouteModule = Partial<Record<'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', Handler>>;
const modules: [string, unknown][] = [
  ['/api/jobs', jobs], ['/api/jobs/batch', batch], ['/api/jobs/:id', job],
  ['/api/jobs/:id/frame', frame], ['/api/jobs/:id/slides/:index', slide],
  ['/api/library', library], ['/api/collections', collections], ['/api/collections/:id', collection],
  ['/api/themes', themes], ['/api/themes/:id', theme], ['/api/backup', backup], ['/api/export', exports],
  ['/api/worker/heartbeat', heartbeat], ['/api/worker/submit', submit], ['/api/worker/claim', claim],
  ['/api/worker/jobs/:id', result], ['/api/worker/jobs/:id/identity', identity],
  ['/api/worker/jobs/:id/slides/:index', uploadSlide],
  ['/api/worker/frames/claim', frameClaim], ['/api/worker/frames/:id', frameResult],
  ['/api/worker/insights/claim', insightClaim], ['/api/worker/insights/:id', insightResult],
  ['/api/worker/slides/claim', slidesClaim], ['/api/worker/slides/:id', slidesResult],
];
const routes = modules.map(([pattern, module]) => {
  const names: string[] = [];
  const expression = pattern.split('/').map(part => {
    if (part.startsWith(':')) { names.push(part.slice(1)); return '([^/]+)'; }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  return { pattern, names, regexp: new RegExp('^' + expression + '/?$'), module: module as RouteModule };
});

export async function dispatchRoute(request: Request): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  for (const route of routes) {
    const match = route.regexp.exec(pathname);
    if (!match) continue;
    const handler = route.module[request.method as keyof RouteModule];
    if (!handler) return Response.json({ error: 'This action is not available.' }, { status: 405, headers: { Allow: Object.keys(route.module).filter(key => /^[A-Z]+$/.test(key)).join(', ') } });
    const params: Record<string, string> = {};
    try { route.names.forEach((name, index) => { params[name] = decodeURIComponent(match[index + 1]); }); }
    catch { return Response.json({ error: 'The address is invalid.' }, { status: 400 }); }
    return handler(request, { params: Promise.resolve(params) });
  }
  return Response.json({ error: 'This local endpoint is not available.' }, { status: 404 });
}
