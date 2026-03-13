import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface SessionStatus {
  hasSession: boolean;
  model: string;
  uptimeSeconds: number;
  groupName: string;
}

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Optional command handlers provided by the orchestrator
  onResetSession?: (chatJid: string) => void;
  onCompact?: (chatJid: string) => void;
  onGetStatus?: (chatJid: string) => SessionStatus | null;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
