import type { NotificationChannelPackage } from "./channel.ts";
import { createSlackChannel } from "./slack/channel.ts";

// The channels this install can send to. Everything outside a channel's own
// folder reaches it through here, by its id: the outbox, the rules, the
// preferences and the setup page. A new chat tool is one folder plus one
// entry here.

let channels: NotificationChannelPackage[] | null = null;

export function getNotificationChannels(): NotificationChannelPackage[] {
  channels ??= [createSlackChannel()];

  return channels;
}

export function getNotificationChannel(
  id: string,
): NotificationChannelPackage | null {
  return getNotificationChannels().find((channel) => channel.id === id) ?? null;
}
