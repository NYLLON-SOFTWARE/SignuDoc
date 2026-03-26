import { createAppAuth } from "./server.ts";

export const auth = createAppAuth({
  includeNextCookies: false,
});

export default auth;
