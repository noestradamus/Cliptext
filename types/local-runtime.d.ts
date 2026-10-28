// Shared route names map to the local SQLite/file adapters in this build.
type D1PreparedStatement = import('../local-app/server/storage').LocalStatement;

declare module 'cloudflare:workers' {
  export const env: typeof import('../local-app/server/bindings').env;
}
