import path from "node:path";

export type ServerConfig = {
  host: "127.0.0.1";
  port: number;
  dataRoot: string;
};

export function resolveServerConfig(env: NodeJS.ProcessEnv): ServerConfig {
  return {
    host: "127.0.0.1",
    port: Number(env.DIARY_PORT ?? 43127),
    dataRoot: path.resolve(env.DIARY_DATA_ROOT ?? "data"),
  };
}
