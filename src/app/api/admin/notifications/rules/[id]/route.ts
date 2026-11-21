import { handleRuleChange } from "@/lib/notifications/rule-routes";
import {
  deleteNotificationRule,
  updateNotificationRule,
} from "@/lib/notifications/rules";

type RuleRouteContext = {
  params: Promise<{
    id: string;
  }>;
};

// Changes a rule; the body is the whole rule, as when it was made.
// Administrators only.
export async function PUT(request: Request, context: RuleRouteContext) {
  const { id } = await context.params;
  const body: unknown = await request.json().catch(() => null);

  return handleRuleChange(request, (actor) =>
    updateNotificationRule(actor, id, body),
  );
}

// Deletes a rule. Administrators only.
export async function DELETE(request: Request, context: RuleRouteContext) {
  const { id } = await context.params;

  return handleRuleChange(request, (actor) =>
    deleteNotificationRule(actor, id),
  );
}
