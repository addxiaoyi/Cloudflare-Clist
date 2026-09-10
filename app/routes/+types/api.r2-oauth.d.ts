import type { Route } from "./api.r2-oauth";

declare namespace Route {
  interface LoaderArgs {
    request: Request;
    context: {
      cloudflare: {
        env: Env;
      };
    };
  }

  interface ActionArgs {
    request: Request;
    context: {
      cloudflare: {
        env: Env;
      };
    };
  }
}