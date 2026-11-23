export const QUERY_KEYS = {
  account: (subject: string) => ["account", subject] as const,
  accountSnapshot: (subject: string) => [...QUERY_KEYS.account(subject), "snapshot"] as const,
  accountHistory: (subject: string) => [...QUERY_KEYS.account(subject), "history"] as const,
  audiobook: (conversionId: string) => ["audiobook", conversionId] as const,
  grant: (grantId: string) => ["conversion-grant", grantId] as const,
  crashReports: () => ["crash-reports"] as const,
};
