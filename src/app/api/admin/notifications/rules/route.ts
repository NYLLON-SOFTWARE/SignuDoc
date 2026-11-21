import { handleRuleChange } from "@/lib/notifications/rule-routes";
import {
  createNotificationRule,
  listNotificationRules,
} from "@/lib/notifications/rules";

// Notification rules: which events go to which channel. Administrators
// only.

export async function GET(request: Request) {
  return handleRuleChange(request, () => listNotificationRules());
}

// Makes a rule: { channel, events, destination, destinationName? }.
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);

  return handleRuleChange(request, (actor) =>
    createNotificationRule(actor, body),
  );
}
