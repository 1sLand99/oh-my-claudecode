export declare const TEAM_REMINDER_INTENTS: readonly ["followup-reuse", "followup-relaunch", "stalled-unblock", "done-review-or-shutdown", "pending-mailbox-review"];
export type TeamReminderIntent = typeof TEAM_REMINDER_INTENTS[number];
export interface TeamReminderDirective {
    text: string;
    intent: TeamReminderIntent;
}
export declare function isTeamReminderIntent(value: unknown): value is TeamReminderIntent;
export declare function resolveLeaderNudgeIntent(reason: string, options?: {
    leaderActionState?: string;
}): TeamReminderIntent;
//# sourceMappingURL=reminder-intents.d.ts.map