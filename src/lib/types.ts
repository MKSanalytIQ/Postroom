export type Account = {
  id: string;
  email: string;
  name: string;
  companyName: string;
  postalAddress: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpConfigured: boolean;
  hasSmtpPassword: boolean;
  createdAt: string;
};

export type ContactList = {
  id: string;
  name: string;
  createdAt: string;
  contactCount: number;
  subscribedCount: number;
};

export type Contact = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  status: string;
  createdAt: string;
  listNames: string;
};

export type Template = {
  id: string;
  name: string;
  subject: string;
  html: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignStatus = "draft" | "sending" | "paused" | "sent";

export type Campaign = {
  id: string;
  name: string;
  subject: string;
  html: string;
  listId: string | null;
  listName: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  status: CampaignStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

export type CampaignStats = {
  total: number;
  sent: number;
  failed: number;
  waiting: number;
  skipped: number;
  uniqueOpens: number;
  opens: number;
  uniqueClicks: number;
  clicks: number;
  unsubscribes: number;
};

export type ClickStat = { url: string; hits: number };

export type DeliveryView = {
  id: string;
  recipientId: string;
  email: string;
  subject: string;
  html: string;
  mode: string;
  token: string;
  status: string;
  createdAt: string;
  /** Set when the message came from an automation rather than a campaign. */
  automationId: string | null;
};

export type FailureRow = {
  email: string;
  error: string;
};

export type Page<T> = {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
};

export type ImportResult = {
  created: number;
  updated: number;
  addedToList: number;
  invalid: number;
  keptUnsubscribed: number;
  /** Rows skipped because the address is on the suppression list. */
  suppressed: number;
};

export type Dashboard = {
  subscribed: number;
  unsubscribed: number;
  lists: number;
  sentCampaigns: number;
  sentRecipients: number;
  uniqueOpens: number;
  uniqueClicks: number;
};

export type SettingsInput = {
  name: string;
  companyName: string;
  postalAddress: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string | null;
};

export type SendJob = {
  recipientId: string;
  campaignId: string;
  contactId: string | null;
  contactStatus: string | null;
  email: string;
  firstName: string;
  lastName: string;
  unsubToken: string;
  token: string;
  subject: string;
  html: string;
  fromName: string;
  fromEmail: string;
  replyTo: string;
  origin: string;
  userId: string;
  campaignStatus: string;
  /** Set when the job belongs to an automation's hidden campaign. */
  automationId: string | null;
};

export type AutomationStatus = "draft" | "active" | "paused";

export type Automation = {
  id: string;
  name: string;
  status: AutomationStatus;
  listId: string | null;
  listName: string | null;
  /** Hidden campaign that owns this automation's recipients, tracking, and stored messages. */
  campaignId: string;
  createdAt: string;
  updatedAt: string;
  stepCount: number;
  emailCount: number;
};

export type AutomationStep = {
  id: string;
  position: number;
  kind: "email" | "delay";
  templateId: string | null;
  templateName: string | null;
  delayMinutes: number;
};

export type EnrollmentCounts = {
  active: number;
  completed: number;
  stopped: number;
  total: number;
  emailsSent: number;
  emailsFailed: number;
  emailsWaiting: number;
};

export type EnrollmentRow = {
  id: string;
  email: string;
  status: "active" | "completed" | "stopped";
  currentStep: number;
  nextRunAt: string;
  stopReason: string;
  createdAt: string;
  completedAt: string | null;
};

export type AutomationRules = {
  exitOnClick: boolean;
  exitListId: string | null;
  exitListName: string | null;
  windowEnabled: boolean;
  /** Allowed weekdays, 0 = Sunday. */
  windowDays: number[];
  windowStartHour: number;
  windowEndHour: number;
  timezone: string;
};

export type StepStats = {
  stepId: string;
  sent: number;
  failed: number;
  waiting: number;
  uniqueOpens: number;
  uniqueClicks: number;
};

export type SuppressionReason = "hard_bounce" | "complaint" | "manual";

export type Suppression = {
  id: string;
  email: string;
  reason: SuppressionReason;
  source: string;
  detail: string;
  createdAt: string;
};
