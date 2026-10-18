'use client';

import React, { useState, useEffect, useRef } from 'react';
import Sidebar from '@/components/Sidebar';
import ChatArea from '@/components/ChatArea';
import ArtifactPanel from '@/components/ArtifactPanel';
import BrowserPanel from '@/components/BrowserPanel';
import ConnectorsModal, { DEFAULT_CONNECTORS, createDefaultConnectors } from '@/components/ConnectorsModal';
import SettingsModal, { SettingsTab } from '@/components/SettingsModal';
import ProjectModal from '@/components/ProjectModal';
import DownloadModal from '@/components/DownloadModal';
import AgentsModal from '@/components/AgentsModal';
import FeaturesModal from '@/components/FeaturesModal';
import { Session, Message, ModelId, Artifact, Project, Attachment, ThinkingBudget, CustomButton, OpenWorkAgent, ConnectorConfig, Connector } from '@/types/chat';

const DEFAULT_CUSTOM_BUTTONS: CustomButton[] = [
  { id: 'btn_1', label: '🚀 Deploy Guide', prompt: 'Provide a production deployment guide with Docker and CI/CD workflow.' },
  { id: 'btn_2', label: '⚡ Optimize Code', prompt: 'Analyze this code for performance bottlenecks and provide optimized code.' },
  { id: 'btn_3', label: '🔍 Security Audit', prompt: 'Audit this implementation for OWASP security vulnerabilities.' },
];

const DEFAULT_SESSION: Session = {
  id: 'ses_default',
  title: 'New Conversation',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [],
  activeModel: 'boss',
  connectors: createDefaultConnectors(),
};


function createWorkspaceSyncCode(): string {
  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeConnectors(raw: any[]): Connector[] {
  // Composio is the sole built-in connector runtime. Preserve only
  // connectors explicitly created by the user; legacy native app cards
  // must never re-enter from localStorage or cloud state.
  const defaults = createDefaultConnectors();
  const byId = new Map<string, Connector>(defaults.map((connector) => [connector.id, connector]));
  const input = Array.isArray(raw)
    ? raw.filter((connector: any) => {
        if (!connector || typeof connector !== 'object') return false;
        const cfg = connector.config || {};
        const type = String(cfg.connectionType || connector.provider || '').toLowerCase();
        const url = String(cfg.mcpUrl || connector.url || '').trim();
        const isDirectMcp = type === 'mcp' && /^https?:\/\//i.test(url) && !/connect\.composio\.dev\/mcp/i.test(url);
        return connector.isCustom === true || isDirectMcp;
      })
    : [];

  for (const connector of input) {
    const url = String(connector?.config?.mcpUrl || connector?.url || '').trim();
    if (!/^https?:\/\//i.test(url)) continue;

    const safeConfig = { ...(connector.config || {}) };
    delete safeConfig.authToken;
    delete safeConfig.apiKey;
    delete safeConfig.clientSecret;

    const safe = {
      ...connector,
      config: { ...safeConfig, connectionType: 'mcp', mcpUrl: url },
      url,
    } as Connector;

    const base = byId.get(safe.id);
    byId.set(
      safe.id,
      base
        ? { ...base, ...safe, config: { ...(base.config || {}), ...(safe.config || {}) } }
        : safe
    );
  }

  return Array.from(byId.values());
}

function extractArtifact(content: string): Artifact | undefined {
  const codeBlockRegex = /