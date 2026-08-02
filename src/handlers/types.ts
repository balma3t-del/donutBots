export type ProxyConfig = {
  host: string;
  port: number;
  user: string;
  pass: string;
};

export type BotRecord = {
  id: number;
  label: string;
  /** Microsoft email (лицензия) */
  email: string;
  /** Microsoft password (опционально; иначе device-code) */
  password: string;
  proxyHost: string;
  proxyPort: number;
  proxyUser: string;
  proxyPass: string;
  reconnect: boolean;
  /** Клики ПКМ в секунду (1–20) */
  clickerCps: number;
  createdAt: string;
};

export type SessionStatus = 'offline' | 'connecting' | 'online';

export type AwaitKind =
  | 'add_email'
  | 'add_password'
  | 'add_proxy'
  | 'set_email'
  | 'set_password'
  | 'set_proxy'
  | 'set_clicker_cps'
  | 'send_chat'
  | null;

export type SessionData = {
  awaitKind?: AwaitKind;
  awaitBotId?: number;
  draftEmail?: string;
  draftPassword?: string;
};
