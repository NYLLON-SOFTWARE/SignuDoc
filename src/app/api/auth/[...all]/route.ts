import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth/server";

const handlers = toNextJsHandler(getAuth());

export const { DELETE, GET, PATCH, POST, PUT } = handlers;
